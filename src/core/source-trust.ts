import { getDomain } from "tldts";

export type SourceAuthority =
  | "DIRECT_WORK"
  | "FIRST_PARTY_INSTITUTIONAL"
  | "INDEPENDENT_PROFESSIONAL"
  | "SELF_REPRESENTATION"
  | "CONTEXT"
  | "DISCOVERY_ONLY";

type SourceArtifact = {
  sourceAuthority?: SourceAuthority | string | null;
  sourceUrl?: string | null;
  provider?: string | null;
  kind?: string | null;
  independenceGroup?: string | null;
};

type SourceEntity = {
  id: string;
  type?: string;
  canonicalName?: string;
  metadata?: Record<string, unknown>;
};

type SourceEntityLink = {
  fromEntityId: string;
  toEntityId: string;
  relationship?: string;
};

type TrustInput = {
  kind: string;
  provider: string;
  sourceUrl?: string;
  provenance: Record<string, unknown>;
  content: unknown;
};

function canonicalHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString();
  } catch { return undefined; }
}

function lineageUrl(input: TrustInput): string | undefined {
  const networkArguments = input.provenance.networkArguments;
  const archivedUrl = networkArguments && typeof networkArguments === "object" && typeof (networkArguments as { url?: unknown }).url === "string"
    ? canonicalHttpUrl(String((networkArguments as { url: string }).url))
    : undefined;
  return input.provider.startsWith("wayback") && archivedUrl ? archivedUrl : input.sourceUrl ? canonicalHttpUrl(input.sourceUrl) : undefined;
}

function serialized(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 5 * 1024 * 1024); }
  catch { return ""; }
}

function doiLineage(content: unknown): string | undefined {
  const match = serialized(content).match(/10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/i);
  return match?.[0].replace(/["'}\],.]+$/g, "").toLocaleLowerCase("en-US");
}

function cveLineage(input: TrustInput): string | undefined {
  const text = `${serialized(input.content)} ${serialized(input.provenance.networkArguments)}`;
  return text.match(/CVE-\d{4}-\d{4,}/i)?.[0].toUpperCase();
}

function linkedinGroup(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  if (!/(^|\.)linkedin\.com$/.test(parsed.hostname)) return undefined;
  const match = parsed.pathname.match(/^\/in\/([^/]+)/i);
  return match ? `linkedin-profile:${decodeURIComponent(match[1]!).toLocaleLowerCase("en-US")}` : "domain:linkedin.com";
}

function githubRepositoryGroup(input: TrustInput, url: string | undefined): string | undefined {
  const network = input.provenance.networkArguments;
  if (network && typeof network === "object" && typeof (network as { repository?: unknown }).repository === "string") {
    return `github-repository:${String((network as { repository: string }).repository).toLocaleLowerCase("en-US")}`;
  }
  if (network && typeof network === "object" && typeof (network as { path?: unknown }).path === "string") {
    const path = String((network as { path: string }).path);
    const repository = path.match(/^\/repos\/([^/?#]+)\/([^/?#]+)/i);
    if (repository) return `github-repository:${decodeURIComponent(repository[1]!).toLocaleLowerCase("en-US")}/${decodeURIComponent(repository[2]!).toLocaleLowerCase("en-US")}`;
    const account = path.match(/^\/users\/([^/?#]+)/i)?.[1];
    if (account) return `github-account:${decodeURIComponent(account).toLocaleLowerCase("en-US")}`;
  }
  if (network && typeof network === "object" && typeof (network as { query?: unknown }).query === "string") {
    const query = String((network as { query: string }).query);
    const repository = query.match(/\brepo:([\w.-]+\/[\w.-]+)/i)?.[1];
    if (repository) return `github-repository:${repository.toLocaleLowerCase("en-US")}`;
    const repositoryCall = query.match(/\brepository\s*\(\s*owner\s*:\s*["']([\w.-]+)["']\s*,\s*name\s*:\s*["']([\w.-]+)["']/i);
    if (repositoryCall) return `github-repository:${repositoryCall[1]!.toLocaleLowerCase("en-US")}/${repositoryCall[2]!.toLocaleLowerCase("en-US")}`;
    const account = query.match(/\buser\s*\(\s*login\s*:\s*["']([\w.-]+)["']/i)?.[1];
    if (account) return `github-account:${account.toLocaleLowerCase("en-US")}`;
  }
  if (!url) return undefined;
  const parsed = new URL(url);
  if (parsed.hostname === "api.github.com") return "domain:github.com";
  if (parsed.hostname !== "github.com") return undefined;
  const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
  return owner && repository ? `github-repository:${owner.toLocaleLowerCase("en-US")}/${repository.replace(/\.git$/i, "").toLocaleLowerCase("en-US")}` : "domain:github.com";
}

function authority(input: TrustInput, canonicalUrl: string | undefined): SourceAuthority {
  const route = String(input.provenance.providerRoute ?? "");
  const network = input.provenance.networkArguments && typeof input.provenance.networkArguments === "object" ? input.provenance.networkArguments as Record<string, unknown> : {};
  const githubDirect = route === "github.clone"
    || route === "github.rest" && typeof network.path === "string" && /^\/repos\/[^/]+\/[^/]+\/(commits|issues|pulls)\b/.test(network.path)
    || route === "github.graphql" && typeof network.query === "string" && /\b(pullRequests?|commits?|reviews?|repository)\b/i.test(network.query);
  if (input.kind === "SEARCH_DISCOVERY") return "DISCOVERY_ONLY";
  if (input.kind.startsWith("INPUT_") || input.provider === "submission") return "SELF_REPRESENTATION";
  if (route.startsWith("linkdapi.") || route.startsWith("brightdata.") || canonicalUrl && /(^|\.)(linkedin|x|instagram|tiktok)\.com$/.test(new URL(canonicalUrl).hostname)) return "SELF_REPRESENTATION";
  if (githubDirect) return "DIRECT_WORK";
  if (route.startsWith("packages.")) return "FIRST_PARTY_INSTITUTIONAL";
  if (route.startsWith("github.")) return "SELF_REPRESENTATION";
  if (route.startsWith("public-records.") || canonicalUrl && (/\.gov$/.test(new URL(canonicalUrl).hostname) || /\.edu$/.test(new URL(canonicalUrl).hostname) || new URL(canonicalUrl).hostname === "datatracker.ietf.org")) return "FIRST_PARTY_INSTITUTIONAL";
  if (canonicalUrl) {
    const domain = getDomain(new URL(canonicalUrl).hostname, { allowPrivateDomains: false });
    if (domain && new Set(["reuters.com", "apnews.com", "bbc.com", "ft.com", "wired.com"]).has(domain)) return "INDEPENDENT_PROFESSIONAL";
  }
  return "CONTEXT";
}

function hostname(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).hostname.toLocaleLowerCase("en-US"); }
  catch { return undefined; }
}

function candidateDomainNames(entities: SourceEntity[], links: SourceEntityLink[], rootCandidate: string | null | undefined): Set<string> {
  if (!rootCandidate) return new Set();
  const linked = new Set<string>();
  for (const link of links) {
    if (link.fromEntityId === rootCandidate) linked.add(link.toEntityId);
    if (link.toEntityId === rootCandidate) linked.add(link.fromEntityId);
  }
  return new Set(entities
    .filter((entity) => linked.has(entity.id) && entity.type === "WEBSITE" && (linkForEntity(entity, links, rootCandidate)))
    .flatMap((entity) => {
      const values = [entity.canonicalName, entity.metadata?.url, entity.metadata?.domain];
      return values.flatMap((value) => typeof value === "string" ? [hostname(value) ?? value.toLocaleLowerCase("en-US")] : []);
    }));
}

function linkForEntity(entity: SourceEntity, links: SourceEntityLink[], rootCandidate: string): boolean {
  return links.some((link) => (link.fromEntityId === rootCandidate && link.toEntityId === entity.id || link.toEntityId === rootCandidate && link.fromEntityId === entity.id)
    && String(link.relationship ?? "").toLocaleUpperCase("en-US").includes("VERIFIED_DOMAIN"));
}

function isVerifiedCandidateDomain(artifact: SourceArtifact, entities: SourceEntity[], links: SourceEntityLink[], rootCandidate: string | null | undefined): boolean {
  const sourceHost = hostname(artifact.sourceUrl);
  return Boolean(sourceHost && candidateDomainNames(entities, links, rootCandidate).has(sourceHost));
}

export function effectiveSourceAuthority(input: {
  artifact: SourceArtifact;
  entities?: SourceEntity[];
  entityLinks?: SourceEntityLink[];
  rootCandidate?: string | null;
}): SourceAuthority {
  const stored = String(input.artifact.sourceAuthority ?? "CONTEXT") as SourceAuthority;
  if (stored === "DISCOVERY_ONLY") return stored;
  if (stored !== "CONTEXT") return stored;
  if (isVerifiedCandidateDomain(input.artifact, input.entities ?? [], input.entityLinks ?? [], input.rootCandidate)) return "SELF_REPRESENTATION";
  return "CONTEXT";
}

export function effectiveAttestationGroup(input: {
  artifact: SourceArtifact;
  entities?: SourceEntity[];
  entityLinks?: SourceEntityLink[];
  rootCandidate?: string | null;
}): string {
  const authority = effectiveSourceAuthority(input);
  const sourceHost = hostname(input.artifact.sourceUrl);
  if (authority === "SELF_REPRESENTATION" && (isVerifiedCandidateDomain(input.artifact, input.entities ?? [], input.entityLinks ?? [], input.rootCandidate) || Boolean(sourceHost && /(^|\.)linkedin\.com$/.test(sourceHost)))) return "CANDIDATE_SELF";
  if (input.artifact.independenceGroup?.startsWith("github-repository:")) return input.artifact.independenceGroup;
  if (authority === "DIRECT_WORK" && input.artifact.independenceGroup) return input.artifact.independenceGroup;
  if ((authority === "FIRST_PARTY_INSTITUTIONAL" || authority === "INDEPENDENT_PROFESSIONAL") && sourceHost) return `domain:${getDomain(sourceHost, { allowPrivateDomains: false }) ?? sourceHost}`;
  return input.artifact.independenceGroup ?? `source:${input.artifact.provider ?? "unknown"}:${input.artifact.kind ?? "unknown"}`;
}

export function deriveArtifactTrust(input: TrustInput): {
  sourceAuthority: SourceAuthority;
  independenceGroup: string;
  canonicalSourceUrl: string;
} {
  const canonicalSourceUrl = lineageUrl(input) ?? `urn:translucid:${encodeURIComponent(input.provider)}:${encodeURIComponent(input.kind)}`;
  const httpUrl = canonicalSourceUrl.startsWith("http") ? canonicalSourceUrl : undefined;
  const doi = doiLineage(input.content);
  const cve = cveLineage(input);
  const linkedIn = linkedinGroup(httpUrl);
  const github = githubRepositoryGroup(input, httpUrl);
  const domain = httpUrl ? getDomain(new URL(httpUrl).hostname, { allowPrivateDomains: false }) : null;
  const independenceGroup = doi ? `doi:${doi}`
    : cve ? `cve:${cve}`
    : linkedIn ?? github ?? (domain ? `domain:${domain}` : `source:${input.provider}:${input.kind}`);
  return {
    sourceAuthority: authority(input, httpUrl),
    independenceGroup,
    canonicalSourceUrl,
  };
}
