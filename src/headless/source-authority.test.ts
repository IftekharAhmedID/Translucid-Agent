import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSourceAuthoritySnapshot,
  normalizeOfficialDomain,
  OFFICIAL_DOMAIN_REGISTRY_PATH,
  readVerifiedOfficialDomainRegistry,
  registerOfficialDomainProposal,
} from "./source-authority.ts";
import { FileSourceStore } from "./source-store.ts";

test("official-domain normalization uses URL and private PSL boundaries", () => {
  assert.equal(normalizeOfficialDomain("https://careers.organization-alpha-unit.co.uk/team").domain, "organization-alpha-unit.co.uk");
  assert.equal(normalizeOfficialDomain("https://tenant.github.io/about").domain, "tenant.github.io");
  assert.equal(normalizeOfficialDomain("https://dept.organization-alpha-unit.co.uk.attacker-unit.org").domain, "attacker-unit.org");

  for (const value of [
    "https://organization.test",
    "https://127.0.0.1",
    "https://localhost",
    "https://com",
    "ftp://organization-alpha-unit.com",
    "https://user:password@organization-alpha-unit.com",
    "https://organization-alpha-unit.com:8443",
  ]) assert.throws(() => normalizeOfficialDomain(value));
});

test("the research-time registry survives disposable finalization checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const onDomain = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://organization-alpha-unit.com/identity",
      mimeType: "text/plain",
      content: "Organization Alpha owns organization-alpha-unit.com.",
      provenance: {},
    });
    await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [{
        sourceRef: onDomain.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
      }],
    });
    await rm(join(root, ".work", "finalization", "v5"), { recursive: true, force: true });
    const { registry } = await readVerifiedOfficialDomainRegistry(root, store);
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0]?.status, "REJECTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid stage-local registry is migrated once for in-flight V5 runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const onDomain = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://organization-alpha-unit.com/identity",
      mimeType: "text/plain",
      content: "Organization Alpha owns organization-alpha-unit.com.",
      provenance: {},
    });
    await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [{
        sourceRef: onDomain.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
      }],
    });
    const legacyPath = join(root, ".work", "finalization", "v5", "official-domain-registry.json");
    await mkdir(join(root, ".work", "finalization", "v5"), { recursive: true });
    await rename(join(root, OFFICIAL_DOMAIN_REGISTRY_PATH), legacyPath);
    const { registry } = await readVerifiedOfficialDomainRegistry(root, store);
    assert.equal(registry.entries.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(root, OFFICIAL_DOMAIN_REGISTRY_PATH), "utf8")), registry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one trusted external source can verify an official domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const proof = await store.capture({
      kind: "PROVIDER_RESPONSE",
      provider: "package-registry",
      providerRoute: "packages.npm",
      sourceUrl: "https://proof-record-unit.org/organization-alpha",
      mimeType: "text/plain",
      content: "Organization Alpha publishes its official site at organization-alpha-unit.com.",
      provenance: {},
    });
    const official = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://careers.organization-alpha-unit.com/team",
      mimeType: "text/plain",
      content: "Organization Alpha engineering team.",
      provenance: {},
    });

    const { registry: initialRegistry } = await readVerifiedOfficialDomainRegistry(root, store);
    const initialSnapshot = await buildSourceAuthoritySnapshot(store, initialRegistry);
    const initialOfficial = initialSnapshot.sources.find(({ sourceRef }) => sourceRef === official.ref)!;
    assert.equal(initialOfficial.effectiveAuthority, "CONTEXT");

    const entry = await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://www.organization-alpha-unit.com",
      proofs: [{
        sourceRef: proof.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
      }],
    });

    assert.equal(entry.status, "VERIFIED");
    assert.equal(entry.verificationMethod, "TRUSTED_EXTERNAL");
    const { registry } = await readVerifiedOfficialDomainRegistry(root, store);
    const snapshot = await buildSourceAuthoritySnapshot(store, registry);
    const promotedOfficial = snapshot.sources.find(({ sourceRef }) => sourceRef === official.ref)!;
    assert.equal(promotedOfficial.effectiveAuthority, "FIRST_PARTY_INSTITUTIONAL");
    assert.equal(promotedOfficial.matchedRegistryEntry, entry.id);
    assert.notEqual(snapshot.registryHash, initialSnapshot.registryHash);
    assert.equal(promotedOfficial.sourceHash, initialOfficial.sourceHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reciprocal proof verifies while self-authentication remains rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const onDomain = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://about.organization-alpha-unit.com/identity",
      mimeType: "text/plain",
      content: "Organization Alpha owns organization-alpha-unit.com.",
      provenance: {},
    });
    const directWork = await store.capture({
      kind: "PROVIDER_RESPONSE",
      provider: "code-host",
      providerRoute: "github.clone",
      sourceUrl: "https://code-record-unit.net/organization-alpha/project",
      mimeType: "text/plain",
      content: "Organization Alpha project metadata links to organization-alpha-unit.com.",
      provenance: { repository: "organization-alpha/project" },
    });

    const rejected = await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [{
        sourceRef: onDomain.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
      }],
    });
    assert.equal(rejected.status, "REJECTED");

    const verified = await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [
        {
          sourceRef: onDomain.ref,
          organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
          domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
        },
        {
          sourceRef: directWork.ref,
          organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
          domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
        },
      ],
    });
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.verificationMethod, "RECIPROCAL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a spoofed suffix in proof text cannot verify a proposed domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const proof = await store.capture({
      kind: "PROVIDER_RESPONSE",
      provider: "package-registry",
      providerRoute: "packages.npm",
      sourceUrl: "https://proof-record-unit.org/organization-alpha",
      mimeType: "text/plain",
      content: "Organization Alpha is discussed at organization-alpha-unit.com.attacker-unit.org.",
      provenance: {},
    });
    const entry = await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [{
        sourceRef: proof.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com.attacker-unit.org" },
      }],
    });
    assert.equal(entry.status, "REJECTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered registry outcomes fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const onDomain = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://organization-alpha-unit.com/identity",
      mimeType: "text/plain",
      content: "Organization Alpha owns organization-alpha-unit.com.",
      provenance: {},
    });
    await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [{
        sourceRef: onDomain.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
      }],
    });
    const path = join(root, OFFICIAL_DOMAIN_REGISTRY_PATH);
    const raw = JSON.parse(await readFile(path, "utf8")) as { entries: Array<Record<string, unknown>> };
    raw.entries[0]!.status = "VERIFIED";
    raw.entries[0]!.verificationMethod = "TRUSTED_EXTERNAL";
    await writeFile(path, JSON.stringify(raw));
    await assert.rejects(readVerifiedOfficialDomainRegistry(root, store), /registry.*integrity|verification outcome/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered registry proposal inputs fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-authority-"));
  try {
    const store = await FileSourceStore.open(root);
    const onDomain = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://organization-alpha-unit.com/identity",
      mimeType: "text/plain",
      content: "Organization Alpha owns organization-alpha-unit.com.",
      provenance: {},
    });
    await registerOfficialDomainProposal(root, store, {
      organization: "Organization Alpha",
      url: "https://organization-alpha-unit.com",
      proofs: [{
        sourceRef: onDomain.ref,
        organizationExcerpt: { path: "$", exactQuote: "Organization Alpha" },
        domainExcerpt: { path: "$", exactQuote: "organization-alpha-unit.com" },
      }],
    });
    const path = join(root, OFFICIAL_DOMAIN_REGISTRY_PATH);
    const raw = JSON.parse(await readFile(path, "utf8")) as { entries: Array<Record<string, unknown>> };
    raw.entries[0]!.organization = "Organization Beta";
    await writeFile(path, JSON.stringify(raw));
    await assert.rejects(readVerifiedOfficialDomainRegistry(root, store));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
