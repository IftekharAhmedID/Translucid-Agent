import { getDomain } from "tldts";

export type SourceAuthority =
  | "DIRECT_WORK"
  | "FIRST_PARTY_INSTITUTIONAL"
  | "INDEPENDENT_PROFESSIONAL"
  | "SELF_REPRESENTATION"
  | "CONTEXT"
  | "DISCOVERY_ONLY";

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
  if (network && typeof network === "object" && typeof (network as { query?: unknown }).query === "string") {
    const repository = String((network as { query: string }).query).match(/\brepo:([\w.-]+\/[\w.-]+)/i)?.[1];
    if (repository) return `github-repository:${repository.toLocaleLowerCase("en-US")}`;
  }
  if (!url) return undefined;
  const parsed = new URL(url);
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
  if (githubDirect || route.startsWith("packages.")) return "DIRECT_WORK";
  if (route.startsWith("github.")) return "SELF_REPRESENTATION";
  if (route.startsWith("public-records.") || canonicalUrl && (/\.gov$/.test(new URL(canonicalUrl).hostname) || /\.edu$/.test(new URL(canonicalUrl).hostname) || new URL(canonicalUrl).hostname === "datatracker.ietf.org")) return "FIRST_PARTY_INSTITUTIONAL";
  if (canonicalUrl) {
    const domain = getDomain(new URL(canonicalUrl).hostname, { allowPrivateDomains: false });
    if (domain && new Set(["reuters.com", "apnews.com", "bbc.com", "ft.com", "wired.com"]).has(domain)) return "INDEPENDENT_PROFESSIONAL";
  }
  return "CONTEXT";
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
