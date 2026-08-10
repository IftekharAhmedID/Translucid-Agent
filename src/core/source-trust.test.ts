import assert from "node:assert/strict";
import test from "node:test";

import { deriveArtifactTrust } from "./source-trust.ts";

test("source authority is backend-derived from capture lineage", () => {
  assert.equal(deriveArtifactTrust({ kind: "SEARCH_DISCOVERY", provider: "exa", sourceUrl: "https://api.exa.ai/search", provenance: {}, content: {} }).sourceAuthority, "DISCOVERY_ONLY");
  assert.equal(deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "linkdapi", sourceUrl: "https://www.linkedin.com/in/Ada", provenance: { providerRoute: "linkdapi.profile" }, content: {} }).sourceAuthority, "SELF_REPRESENTATION");
  assert.equal(deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "github", sourceUrl: "https://github.com/acme/tool", provenance: { providerRoute: "github.clone" }, content: {} }).sourceAuthority, "DIRECT_WORK");
  assert.equal(deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://engineering.example.com/team/ada", provenance: {}, content: {} }).sourceAuthority, "CONTEXT");
  assert.equal(deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://www.reuters.com/technology/example", provenance: {}, content: {} }).sourceAuthority, "INDEPENDENT_PROFESSIONAL");
});

test("LinkdAPI and Bright Data views of one LinkedIn profile share an independence group", () => {
  const linkd = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "linkdapi", sourceUrl: "https://linkedin.com/in/Ada/#about", provenance: { providerRoute: "linkdapi.profile" }, content: {} });
  const bright = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "brightdata-linkedin-profile", sourceUrl: "https://www.linkedin.com/in/ada", provenance: { providerRoute: "brightdata.linkedin-profile" }, content: {} });
  assert.equal(linkd.independenceGroup, bright.independenceGroup);
});

test("live and archived captures group by the underlying registrable domain", () => {
  const live = deriveArtifactTrust({ kind: "SOURCE_CONTENT", provider: "public-fetch", sourceUrl: "https://careers.example.co.uk/team/ada", provenance: {}, content: {} });
  const archive = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "wayback", sourceUrl: "https://web.archive.org/web/20200101000000/https://careers.example.co.uk/team/ada", provenance: { providerRoute: "wayback.capture", networkArguments: { url: "https://careers.example.co.uk/team/ada" } }, content: {} });
  assert.equal(live.independenceGroup, "domain:example.co.uk");
  assert.equal(archive.independenceGroup, live.independenceGroup);
});

test("DOI and CVE lineages override provider domains", () => {
  const openAlex = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "openalex", sourceUrl: "https://api.openalex.org/works", provenance: {}, content: { doi: "https://doi.org/10.1234/EXAMPLE.1" } });
  const crossref = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "crossref", sourceUrl: "https://api.crossref.org/works", provenance: {}, content: { DOI: "10.1234/example.1" } });
  assert.equal(openAlex.independenceGroup, crossref.independenceGroup);
  const cve = deriveArtifactTrust({ kind: "PROVIDER_RESPONSE", provider: "nvd", sourceUrl: "https://nvd.nist.gov", provenance: {}, content: { id: "CVE-2025-12345" } });
  assert.equal(cve.independenceGroup, "cve:CVE-2025-12345");
});
