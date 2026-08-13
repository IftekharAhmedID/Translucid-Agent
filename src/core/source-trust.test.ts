import assert from "node:assert/strict";
import test from "node:test";

import { deriveArtifactTrust, effectiveAttestationGroup, effectiveSourceAuthority, SOURCE_AUTHORITY_POLICY_VERSION } from "./source-trust.ts";

test("offline authority policy never promotes a web domain by name", () => {
  assert.equal(SOURCE_AUTHORITY_POLICY_VERSION, "verified-domain-registry-v1");
  assert.equal(effectiveSourceAuthority({ artifact: { sourceAuthority: "CONTEXT", sourceUrl: "https://organization.test/about" } }), "CONTEXT");
});

test("source authority is backend-derived from capture lineage", () => {
  assert.equal(deriveArtifactTrust({ kind: "SEARCH_DISCOVERY", provider: "exa", sourceUrl: "https://api.exa.ai/search", provenance: {}, content: {} }).sourceAuthority, "DISCOVERY_ONLY");
  assert.equal(deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "linkdapi", sourceUrl: "https://www.linkedin.com/in/Ada", provenance: { providerRoute: "linkdapi.profile" }, content: {} }).sourceAuthority, "SELF_REPRESENTATION");
  assert.equal(deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "github", sourceUrl: "https://github.com/acme/tool", provenance: { providerRoute: "github.clone" }, content: {} }).sourceAuthority, "DIRECT_WORK");
  const githubGraphql = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "github", sourceUrl: "https://api.github.com/graphql", provenance: { providerRoute: "github.graphql", networkArguments: { query: "search(query: \"repo:sample-org/sample-repo is:pr\") { edges { node { ... on PullRequest { number } } } }" } }, content: {} });
  assert.equal(githubGraphql.sourceAuthority, "DIRECT_WORK");
  assert.equal(githubGraphql.independenceGroup, "github-repository:sample-org/sample-repo");
  assert.equal(deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://engineering.organization.test/team/casey", provenance: {}, content: {} }).sourceAuthority, "CONTEXT");
  assert.equal(deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://news.publisher.test/story", provenance: {}, content: {} }).sourceAuthority, "CONTEXT");
  assert.equal(deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://records.agency.gov/item", provenance: {}, content: {} }).sourceAuthority, "CONTEXT");
  assert.equal(deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "public-records", sourceUrl: "https://records.provider.test/item", provenance: { providerRoute: "public-records.registry" }, content: {} }).sourceAuthority, "FIRST_PARTY_INSTITUTIONAL");
});

test("GitHub REST and GraphQL artifacts use repository or account lineage instead of the API domain", () => {
  const restCommit = deriveArtifactTrust({
    kind: "PROVIDER_RESPONSE",
    provider: "github",
    sourceUrl: "https://api.github.com/repos/sample-org/sample-repo/commits?author=casey",
    provenance: { providerRoute: "github.rest", networkArguments: { path: "/repos/sample-org/sample-repo/commits?author=casey" } },
    content: {},
  });
  assert.equal(restCommit.sourceAuthority, "DIRECT_WORK");
  assert.equal(restCommit.independenceGroup, "github-repository:sample-org/sample-repo");

  const repositoryQuery = deriveArtifactTrust({
    kind: "PROVIDER_RESPONSE",
    provider: "github",
    sourceUrl: "https://api.github.com/graphql",
    provenance: { providerRoute: "github.graphql", networkArguments: { query: "query { repository(owner: \"sample-org\", name: \"sample-repo\") { pullRequests(first: 5) { nodes { number } } } }" } },
    content: {},
  });
  assert.equal(repositoryQuery.independenceGroup, "github-repository:sample-org/sample-repo");

  const accountQuery = deriveArtifactTrust({
    kind: "PROVIDER_RESPONSE",
    provider: "github",
    sourceUrl: "https://api.github.com/graphql",
    provenance: { providerRoute: "github.graphql", networkArguments: { query: "query { user(login: \"Ada\") { contributionsCollection { totalCommitContributions } } }" } },
    content: {},
  });
  assert.equal(accountQuery.independenceGroup, "github-account:ada");
});

test("LinkdAPI and Bright Data views of one LinkedIn profile share an independence group", () => {
  const linkd = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "linkdapi", sourceUrl: "https://linkedin.com/in/Ada/#about", provenance: { providerRoute: "linkdapi.profile" }, content: {} });
  const bright = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "brightdata-linkedin-profile", sourceUrl: "https://www.linkedin.com/in/ada", provenance: { providerRoute: "brightdata.linkedin-profile" }, content: {} });
  assert.equal(linkd.independenceGroup, bright.independenceGroup);
});

test("live and archived captures group by the underlying registrable domain", () => {
  const live = deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://careers.synthetic-unit.co.uk/team/casey", provenance: {}, content: {} });
  const archive = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "wayback", sourceUrl: "https://web.archive.org/web/20200101000000/https://careers.synthetic-unit.co.uk/team/casey", provenance: { providerRoute: "wayback.capture", networkArguments: { url: "https://careers.synthetic-unit.co.uk/team/casey" } }, content: {} });
  assert.equal(live.independenceGroup, "domain:synthetic-unit.co.uk");
  assert.equal(archive.independenceGroup, live.independenceGroup);
});

test("DOI and CVE lineages override provider domains", () => {
  const openAlex = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "openalex", sourceUrl: "https://api.openalex.org/works", provenance: {}, content: { doi: "https://doi.org/10.1234/EXAMPLE.1" } });
  const crossref = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "crossref", sourceUrl: "https://api.crossref.org/works", provenance: {}, content: { DOI: "10.1234/example.1" } });
  assert.equal(openAlex.independenceGroup, crossref.independenceGroup);
  const cve = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "nvd", sourceUrl: "https://nvd.nist.gov", provenance: {}, content: { id: "CVE-2025-12345" } });
  assert.equal(cve.independenceGroup, "cve:CVE-2025-12345");
});

test("effective candidate-domain authority is computed without changing stored artifact authority", () => {
  const artifact = { sourceAuthority: "CONTEXT", sourceUrl: "https://profile-owner.test/work", provider: "public-fetch", kind: "SOURCE_CONTENT", independenceGroup: "domain:profile-owner.test" };
  const entities = [{ id: "root", type: "PERSON", canonicalName: "Casey Morgan" }, { id: "website", type: "WEBSITE", canonicalName: "profile-owner.test" }];
  const links = [{ fromEntityId: "root", toEntityId: "website", relationship: "VERIFIED_DOMAIN" }];
  assert.equal(effectiveSourceAuthority({ artifact, entities, entityLinks: links, rootCandidate: "root" }), "SELF_REPRESENTATION");
  assert.equal(effectiveAttestationGroup({ artifact, entities, entityLinks: links, rootCandidate: "root" }), "CANDIDATE_SELF");
  assert.equal(artifact.sourceAuthority, "CONTEXT");
});

test("package registry records receive institutional authority", () => {
  assert.equal(deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "pypi", sourceUrl: "https://pypi.org/pypi/example/json", provenance: { providerRoute: "packages.pypi" }, content: {} }).sourceAuthority, "FIRST_PARTY_INSTITUTIONAL");
});
