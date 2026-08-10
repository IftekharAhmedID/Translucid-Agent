export const capabilityNames = [
  "WEB_SEARCH",
  "LINKEDIN_PROFILE",
  "LINKEDIN_ACTIVITY",
  "SOCIAL_PROFILE",
  "PROFESSIONAL_HISTORY",
  "GITHUB",
  "ARCHIVES",
  "PUBLIC_RECORDS",
  "PATENTS",
  "SCHOLARLY",
  "PACKAGES",
  "SECURITY_RECORDS",
] as const;

export type Capability = (typeof capabilityNames)[number];
export type CapabilityState =
  | "READY"
  | "READY_FIXTURE"
  | "DEGRADED"
  | "DISABLED_MISSING_CONFIG"
  | "DISABLED_POLICY";

export type CapabilityEntry = {
  capability: Capability;
  state: CapabilityState;
  routes: string[];
  reason: string;
};

export type CapabilityRegistry = Record<Capability, CapabilityEntry>;
type Environment = Record<string, string | undefined>;

function entry(
  capability: Capability,
  state: CapabilityState,
  routes: string[],
  reason: string,
): CapabilityEntry {
  return { capability, state, routes, reason };
}

function fixtureRegistry(): CapabilityRegistry {
  return Object.fromEntries(
    capabilityNames.map((capability) => [
      capability,
      entry(capability, "READY_FIXTURE", ["fixture"], "Synthetic fixture adapter is ready."),
    ]),
  ) as CapabilityRegistry;
}

export function buildCapabilityRegistry(environment: Environment): CapabilityRegistry {
  if ((environment.PROVIDER_MODE ?? "fixture") === "fixture") {
    return fixtureRegistry();
  }

  const hasBrightProfile = Boolean(
    environment.BRIGHTDATA_API_KEY && environment.BRIGHTDATA_LINKEDIN_PROFILE_DATASET_ID,
  );
  const hasBrightActivity = Boolean(
    environment.BRIGHTDATA_API_KEY && environment.BRIGHTDATA_LINKEDIN_POSTS_DATASET_ID,
  );
  const socialRoutes = [
    ["brightdata-x", environment.BRIGHTDATA_X_PROFILE_DATASET_ID],
    ["brightdata-instagram", environment.BRIGHTDATA_INSTAGRAM_PROFILE_DATASET_ID],
    ["brightdata-tiktok", environment.BRIGHTDATA_TIKTOK_PROFILE_DATASET_ID],
  ].filter(([, dataset]) => environment.BRIGHTDATA_API_KEY && dataset)
    .map(([route]) => route as string);

  const linkedInRoutes = [
    environment.LINKDAPI_API_KEY ? "linkdapi" : undefined,
    hasBrightProfile ? "brightdata-linkedin-profile" : undefined,
  ].filter((route): route is string => Boolean(route));
  const identifiedPublicClient = Boolean(environment.PUBLIC_API_CONTACT_EMAIL);

  return {
    WEB_SEARCH: environment.EXA_API_KEY
      ? entry("WEB_SEARCH", "READY", ["exa"], "Exa API configuration is present.")
      : entry("WEB_SEARCH", "DISABLED_MISSING_CONFIG", [], "EXA_API_KEY is missing."),
    LINKEDIN_PROFILE: linkedInRoutes.length
      ? entry("LINKEDIN_PROFILE", "READY", linkedInRoutes, "At least one profile route is configured.")
      : entry(
          "LINKEDIN_PROFILE",
          "DISABLED_MISSING_CONFIG",
          [],
          "LinkdAPI or Bright Data profile configuration is required.",
        ),
    LINKEDIN_ACTIVITY: environment.LINKDAPI_API_KEY || hasBrightActivity
      ? entry(
          "LINKEDIN_ACTIVITY",
          "READY",
          [
            ...(environment.LINKDAPI_API_KEY ? ["linkdapi"] : []),
            ...(hasBrightActivity ? ["brightdata-linkedin-posts"] : []),
          ],
          "At least one activity route is configured.",
        )
      : entry(
          "LINKEDIN_ACTIVITY",
          "DISABLED_MISSING_CONFIG",
          [],
          "LinkdAPI or Bright Data posts configuration is required.",
        ),
    SOCIAL_PROFILE: socialRoutes.length
      ? entry("SOCIAL_PROFILE", "READY", socialRoutes, "Configured social datasets are available.")
      : entry(
          "SOCIAL_PROFILE",
          "DISABLED_MISSING_CONFIG",
          [],
          "No social-profile dataset ID is configured.",
        ),
    PROFESSIONAL_HISTORY: entry(
      "PROFESSIONAL_HISTORY",
      "DISABLED_POLICY",
      [],
      "Live PDL use is disabled by employment-evaluation policy.",
    ),
    GITHUB: environment.GITHUB_TOKEN
      ? entry("GITHUB", "READY", ["github"], "Read-only GitHub token is configured.")
      : entry("GITHUB", "DISABLED_MISSING_CONFIG", [], "GITHUB_TOKEN is required."),
    ARCHIVES: identifiedPublicClient
      ? entry("ARCHIVES", "READY", ["wayback", "common-crawl"], "Public archive routes are available.")
      : entry("ARCHIVES", "DISABLED_MISSING_CONFIG", [], "PUBLIC_API_CONTACT_EMAIL is required."),
    PUBLIC_RECORDS: identifiedPublicClient
      ? entry("PUBLIC_RECORDS", "READY", ["sec-edgar", "ietf-datatracker"], "Public SEC and IETF routes are available.")
      : entry("PUBLIC_RECORDS", "DISABLED_MISSING_CONFIG", [], "PUBLIC_API_CONTACT_EMAIL is required."),
    PATENTS: environment.USPTO_API_KEY && identifiedPublicClient
      ? entry("PATENTS", "READY", ["uspto-odp"], "USPTO API configuration is present.")
      : entry("PATENTS", "DISABLED_MISSING_CONFIG", [], "USPTO_API_KEY and PUBLIC_API_CONTACT_EMAIL are required."),
    SCHOLARLY: environment.OPENALEX_API_KEY && identifiedPublicClient
      ? entry(
          "SCHOLARLY",
          "READY",
          ["openalex", "crossref"],
          "OpenAlex and Crossref routes are available.",
        )
      : identifiedPublicClient ? entry(
          "SCHOLARLY",
          "DEGRADED",
          ["crossref"],
          "OPENALEX_API_KEY is missing; Crossref remains available.",
        ) : entry("SCHOLARLY", "DISABLED_MISSING_CONFIG", [], "PUBLIC_API_CONTACT_EMAIL is required."),
    PACKAGES: identifiedPublicClient
      ? entry("PACKAGES", "READY", ["npm", "pypi", "hugging-face"], "Public package registries are available.")
      : entry("PACKAGES", "DISABLED_MISSING_CONFIG", [], "PUBLIC_API_CONTACT_EMAIL is required."),
    SECURITY_RECORDS: identifiedPublicClient
      ? entry("SECURITY_RECORDS", "READY", ["osv", ...(environment.GITHUB_TOKEN ? ["github-advisories"] : []), "nvd"], environment.NVD_API_KEY ? "Public routes are available; NVD enhanced rate limits are configured." : "Public routes are available; NVD uses anonymous rate limits.")
      : entry("SECURITY_RECORDS", "DISABLED_MISSING_CONFIG", [], "PUBLIC_API_CONTACT_EMAIL is required."),
  };
}
