import { z } from "zod";

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const nonNegativeNumber = (fallback: number) =>
  z.coerce.number().nonnegative().default(fallback);

const optionalNonNegativeNumber = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().nonnegative().optional(),
);

export type ModelRequestTimeouts = {
  researchMs: number;
  coverageMs: number;
  packetMs: number;
  summaryMs: number;
  auditMs: number;
  safetyReserveMs: number;
};

export const DEFAULT_MODEL_REQUEST_TIMEOUTS: ModelRequestTimeouts = {
  researchMs: 360_000,
  coverageMs: 480_000,
  packetMs: 600_000,
  summaryMs: 360_000,
  auditMs: 600_000,
  safetyReserveMs: 15_000,
};

const modelRequestTimeoutFields = {
  MODEL_RESEARCH_TIMEOUT_MS: positiveInteger(DEFAULT_MODEL_REQUEST_TIMEOUTS.researchMs),
  MODEL_COVERAGE_TIMEOUT_MS: positiveInteger(DEFAULT_MODEL_REQUEST_TIMEOUTS.coverageMs),
  MODEL_PACKET_TIMEOUT_MS: positiveInteger(DEFAULT_MODEL_REQUEST_TIMEOUTS.packetMs),
  MODEL_SUMMARY_TIMEOUT_MS: positiveInteger(DEFAULT_MODEL_REQUEST_TIMEOUTS.summaryMs),
  MODEL_AUDIT_TIMEOUT_MS: positiveInteger(DEFAULT_MODEL_REQUEST_TIMEOUTS.auditMs),
  MODEL_REQUEST_SAFETY_RESERVE_MS: positiveInteger(DEFAULT_MODEL_REQUEST_TIMEOUTS.safetyReserveMs),
};

const modelRequestTimeoutSchema = z.object(modelRequestTimeoutFields);

const environmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    APP_ORIGIN: z.url().default("http://127.0.0.1:3000"),
    RUNNER_GATEWAY_ORIGIN: z.url().default("http://127.0.0.1:3001"),
    E2B_GATEWAY_PUBLIC_URL: z.string().optional(),
    DATA_CLASSIFICATION: z.enum(["SYNTHETIC", "PUBLIC_PROFESSIONAL"]).default("SYNTHETIC"),
    OPENCODE_PROVIDER: z.enum(["ZEN", "GO"]).optional(),
    RESEARCH_OPENCODE_PROVIDER: z.enum(["ZEN", "GO"]).optional(),
    FINALIZER_OPENCODE_PROVIDER: z.enum(["ZEN", "GO"]).default("GO"),
    RESEARCH_MODEL: z.string().min(1).default("deepseek-v4-flash"),
    FINALIZER_MODEL: z.string().min(1).default("mimo-v2.5-pro"),
    FINALIZER_AUDITOR_MODEL: z.string().min(1).optional(),
    REASONING_VARIANT: z.literal("medium").default("medium"),
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
    GITHUB_CONCURRENCY: positiveInteger(4),
    ARCHIVES_CONCURRENCY: positiveInteger(3),
    PUBLIC_RECORDS_CONCURRENCY: positiveInteger(3),
    SCHOLARLY_CONCURRENCY: positiveInteger(3),
    PACKAGES_CONCURRENCY: positiveInteger(3),
    SECURITY_RECORDS_CONCURRENCY: positiveInteger(3),
    INVESTIGATION_TIMEOUT_MS: positiveInteger(3_600_000),
    FINALIZATION_RESERVE_MS: positiveInteger(720_000),
    WEB_SEARCH_CEILING: positiveInteger(1_000),
    WEB_FETCH_CEILING: positiveInteger(2_000),
    PROFESSIONAL_PROFILE_CEILING: positiveInteger(20),
    PROFESSIONAL_ACTIVITY_CEILING: positiveInteger(10),
    SOCIAL_PROFILE_CEILING: positiveInteger(10),
    GITHUB_GRAPHQL_CEILING: positiveInteger(200),
    GITHUB_REST_CEILING: positiveInteger(400),
    GITHUB_CLONE_CEILING: positiveInteger(3),
    ARCHIVES_CEILING: positiveInteger(100),
    PUBLIC_RECORDS_CEILING: positiveInteger(100),
    SCHOLARLY_CEILING: positiveInteger(100),
    PACKAGES_CEILING: positiveInteger(100),
    SECURITY_RECORDS_CEILING: positiveInteger(100),
    LINKDAPI_COST_USD_PER_CALL: optionalNonNegativeNumber,
    BRIGHTDATA_COST_USD_PER_RECORD: optionalNonNegativeNumber,
    MODEL_BUDGET_USD: nonNegativeNumber(5),
    PROVIDER_BUDGET_USD: nonNegativeNumber(10),
    ...modelRequestTimeoutFields,
  })
  .passthrough();

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadModelRequestTimeouts(environment: Record<string, string | undefined>): ModelRequestTimeouts {
  const parsed = modelRequestTimeoutSchema.parse(environment);
  return {
    researchMs: parsed.MODEL_RESEARCH_TIMEOUT_MS,
    coverageMs: parsed.MODEL_COVERAGE_TIMEOUT_MS,
    packetMs: parsed.MODEL_PACKET_TIMEOUT_MS,
    summaryMs: parsed.MODEL_SUMMARY_TIMEOUT_MS,
    auditMs: parsed.MODEL_AUDIT_TIMEOUT_MS,
    safetyReserveMs: parsed.MODEL_REQUEST_SAFETY_RESERVE_MS,
  };
}

export function loadConfig(environment: Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(environment);

  if (parsed.PDL_LIVE_ENABLED === "true") {
    throw new Error("PDL live execution is disabled by policy.");
  }
  if (parsed.FINALIZATION_RESERVE_MS >= parsed.INVESTIGATION_TIMEOUT_MS) {
    throw new Error("The finalization reserve must be smaller than the investigation deadline.");
  }
  if (parsed.RUNTIME_DEFAULT === "E2B") {
    if (!parsed.E2B_API_KEY || !parsed.E2B_TEMPLATE_ID) {
      throw new Error("E2B runtime requires E2B_API_KEY and E2B_TEMPLATE_ID.");
    }
    if (!parsed.E2B_GATEWAY_PUBLIC_URL?.startsWith("https://")) {
      throw new Error("E2B runtime requires an HTTPS E2B_GATEWAY_PUBLIC_URL.");
    }
  }

  const researchOpenCodeProvider = parsed.RESEARCH_OPENCODE_PROVIDER ?? parsed.OPENCODE_PROVIDER ?? "GO";
  const upstreamUrl = (provider: "ZEN" | "GO") => provider === "GO"
    ? "https://opencode.ai/zen/go/v1/chat/completions"
    : "https://opencode.ai/zen/v1/chat/completions";

  return {
    databaseUrl: parsed.DATABASE_URL,
    appOrigin: parsed.APP_ORIGIN,
    runnerGatewayOrigin: parsed.RUNNER_GATEWAY_ORIGIN,
    e2bGatewayPublicUrl: parsed.E2B_GATEWAY_PUBLIC_URL,
    dataClassification: parsed.DATA_CLASSIFICATION,
    researchOpenCodeProvider,
    finalizerOpenCodeProvider: parsed.FINALIZER_OPENCODE_PROVIDER,
    researchOpenCodeUpstreamUrl: upstreamUrl(researchOpenCodeProvider),
    finalizerOpenCodeUpstreamUrl: upstreamUrl(parsed.FINALIZER_OPENCODE_PROVIDER),
    researchModel: parsed.RESEARCH_MODEL,
    finalizerModel: parsed.FINALIZER_MODEL,
    finalizerAuditorModel: parsed.FINALIZER_AUDITOR_MODEL ?? parsed.FINALIZER_MODEL,
    reasoningVariant: parsed.REASONING_VARIANT,
    openCodeProvider: researchOpenCodeProvider,
    openCodeUpstreamUrl: upstreamUrl(researchOpenCodeProvider),
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
      GITHUB: parsed.GITHUB_CONCURRENCY,
      ARCHIVES: parsed.ARCHIVES_CONCURRENCY,
      PUBLIC_RECORDS: parsed.PUBLIC_RECORDS_CONCURRENCY,
      SCHOLARLY: parsed.SCHOLARLY_CONCURRENCY,
      PACKAGES: parsed.PACKAGES_CONCURRENCY,
      SECURITY_RECORDS: parsed.SECURITY_RECORDS_CONCURRENCY,
    },
    investigationTimeoutMs: parsed.INVESTIGATION_TIMEOUT_MS,
    finalizationReserveMs: parsed.FINALIZATION_RESERVE_MS,
    toolCeilings: {
      "web.search": parsed.WEB_SEARCH_CEILING,
      "web.fetch": parsed.WEB_FETCH_CEILING,
      "professional.profile": parsed.PROFESSIONAL_PROFILE_CEILING,
      "professional.activity": parsed.PROFESSIONAL_ACTIVITY_CEILING,
      "social.profile": parsed.SOCIAL_PROFILE_CEILING,
      "github.graphql": parsed.GITHUB_GRAPHQL_CEILING,
      "github.rest": parsed.GITHUB_REST_CEILING,
      "github.clone": parsed.GITHUB_CLONE_CEILING,
      "archives.search": parsed.ARCHIVES_CEILING,
      "public_records.search": parsed.PUBLIC_RECORDS_CEILING,
      "scholarly.search": parsed.SCHOLARLY_CEILING,
      "packages.inspect": parsed.PACKAGES_CEILING,
      "security_records.search": parsed.SECURITY_RECORDS_CEILING,
    },
    providerUnitCosts: {
      LINKDAPI: parsed.LINKDAPI_COST_USD_PER_CALL,
      BRIGHTDATA: parsed.BRIGHTDATA_COST_USD_PER_RECORD,
    },
    modelBudgetUsd: parsed.MODEL_BUDGET_USD,
    providerBudgetUsd: parsed.PROVIDER_BUDGET_USD,
    modelRequestTimeouts: {
      researchMs: parsed.MODEL_RESEARCH_TIMEOUT_MS,
      coverageMs: parsed.MODEL_COVERAGE_TIMEOUT_MS,
      packetMs: parsed.MODEL_PACKET_TIMEOUT_MS,
      summaryMs: parsed.MODEL_SUMMARY_TIMEOUT_MS,
      auditMs: parsed.MODEL_AUDIT_TIMEOUT_MS,
      safetyReserveMs: parsed.MODEL_REQUEST_SAFETY_RESERVE_MS,
    },
  };
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= loadConfig(process.env);
  return cachedConfig;
}
