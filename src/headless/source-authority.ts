import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "tldts";
import { z } from "zod";

import { SOURCE_AUTHORITY_POLICY_VERSION, type SourceAuthority } from "../core/source-trust.ts";
import { atomicJson } from "./incremental-finalization.ts";
import type { CapturedSourceMetadata, FileSourceStore } from "./source-store.ts";

export const OFFICIAL_DOMAIN_REGISTRY_PATH = ".work/official-domain-registry.json";
const LEGACY_OFFICIAL_DOMAIN_REGISTRY_PATH = ".work/finalization/v5/official-domain-registry.json";

const proofExcerptSchema = z.object({
  path: z.string().min(1).max(2_000),
  exactQuote: z.string().min(1).max(4_000),
}).strict();

export const officialDomainRegistrationSchema = z.object({
  organization: z.string().trim().min(2).max(300),
  url: z.string().min(1).max(2_000),
  proofs: z.array(z.object({
    sourceRef: z.string().regex(/^S[1-9]\d*$/),
    organizationExcerpt: proofExcerptSchema,
    domainExcerpt: proofExcerptSchema,
  }).strict()).min(1).max(4),
}).strict();

const proofSchema = officialDomainRegistrationSchema.shape.proofs.element;
const verificationMethodSchema = z.enum(["TRUSTED_EXTERNAL", "RECIPROCAL"]);
const sourceAuthoritySchema = z.enum(["DIRECT_WORK", "FIRST_PARTY_INSTITUTIONAL", "INDEPENDENT_PROFESSIONAL", "SELF_REPRESENTATION", "CONTEXT", "DISCOVERY_ONLY"]);
const registryEntrySchema = z.object({
  id: z.string().regex(/^OD[a-f0-9]{64}$/),
  organization: z.string().min(2).max(300),
  domain: z.string().nullable(),
  normalizationError: z.string().max(1_000).nullable(),
  proofs: z.array(proofSchema).min(1).max(4),
  status: z.enum(["VERIFIED", "REJECTED"]),
  verificationMethod: verificationMethodSchema.nullable(),
  proofSourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(4),
  proofSourceHashes: z.record(z.string().regex(/^S[1-9]\d*$/), z.string().regex(/^[a-f0-9]{64}$/)),
  rejectionReason: z.string().max(2_000).nullable(),
}).strict();

const registryWithoutHashSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.string().min(1),
  entries: z.array(registryEntrySchema).max(500),
}).strict();

export const officialDomainRegistrySchema = registryWithoutHashSchema.extend({
  registryHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const sourceAuthoritySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.string().min(1),
  registryHash: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(z.object({
    sourceRef: z.string().regex(/^S[1-9]\d*$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAuthority: sourceAuthoritySchema,
    effectiveAuthority: sourceAuthoritySchema,
    matchedRegistryEntry: z.string().regex(/^OD[a-f0-9]{64}$/).nullable(),
    verificationMethod: verificationMethodSchema.nullable(),
    proofSourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(4),
    registryHash: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: z.string().min(1),
    attestationGroup: z.string().min(1),
  }).strict()),
}).strict();

export type OfficialDomainRegistration = z.infer<typeof officialDomainRegistrationSchema>;
export type OfficialDomainRegistryEntry = z.infer<typeof registryEntrySchema>;
export type OfficialDomainRegistry = z.infer<typeof officialDomainRegistrySchema>;
export type SourceAuthoritySnapshot = z.infer<typeof sourceAuthoritySnapshotSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function registryHash(value: z.infer<typeof registryWithoutHashSchema>): string {
  return hash(value);
}

export function normalizeOfficialDomain(input: string): { domain: string; hostname: string } {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Official-domain URLs must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Official-domain URLs cannot contain credentials.");
  if (url.port) throw new Error("Official-domain URLs cannot contain a non-default port.");
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const parsed = parse(hostname, { extractHostname: false, allowPrivateDomains: true, detectSpecialUse: true });
  if (parsed.isIp) throw new Error("Official-domain URLs cannot use an IP address.");
  if (parsed.isSpecialUse) throw new Error("Official-domain URLs cannot use a special-use name.");
  if (!parsed.domain || !parsed.publicSuffix || parsed.domain === parsed.publicSuffix) throw new Error("Official-domain URLs require a registrable domain.");
  return { hostname, domain: parsed.domain.toLocaleLowerCase("en-US") };
}

function sourceDomain(source: CapturedSourceMetadata): string | undefined {
  if (!source.sourceUrl) return undefined;
  try { return normalizeOfficialDomain(source.sourceUrl).domain; }
  catch { return undefined; }
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function quoteMentionsDomain(quote: string, expectedDomain: string): boolean {
  const candidates = normalizedText(quote).match(/https?:\/\/[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z0-9-]+/gu) ?? [];
  return candidates.some((candidate) => {
    const trimmed = candidate.replace(/[),.;:[\]{}]+$/gu, "");
    try { return normalizeOfficialDomain(trimmed.includes("://") ? trimmed : `https://${trimmed}`).domain === expectedDomain; }
    catch { return false; }
  });
}

function proposalId(entry: Omit<ReturnType<typeof entryCore>, "id">): string {
  return `OD${hash(entry)}`;
}

function entryCore(entry: OfficialDomainRegistryEntry) {
  return {
    id: entry.id,
    organization: entry.organization,
    domain: entry.domain,
    normalizationError: entry.normalizationError,
    proofs: entry.proofs,
  };
}

async function verifyEntry(store: FileSourceStore, entry: ReturnType<typeof entryCore>): Promise<OfficialDomainRegistryEntry> {
  const rejected = (reason: string, proofSourceHashes: Record<string, string> = {}): OfficialDomainRegistryEntry => ({
    ...entry,
    status: "REJECTED",
    verificationMethod: null,
    proofSourceRefs: Object.keys(proofSourceHashes).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))),
    proofSourceHashes,
    rejectionReason: reason,
  });
  if (entry.id !== proposalId({ organization: entry.organization, domain: entry.domain, normalizationError: entry.normalizationError, proofs: entry.proofs })) {
    return rejected("The proposal identifier does not match its immutable inputs.");
  }
  if (!entry.domain) return rejected(entry.normalizationError ?? "The proposed domain could not be normalized.");

  const proofs: Array<{ source: CapturedSourceMetadata; domain: string }> = [];
  const sourceHashes: Record<string, string> = {};
  for (const proof of entry.proofs) {
    let source: CapturedSourceMetadata;
    try { source = await store.get(proof.sourceRef); }
    catch { return rejected(`Proof source ${proof.sourceRef} does not exist.`, sourceHashes); }
    sourceHashes[source.ref] = source.sha256;
    const [organizationExact, domainExact] = await Promise.all([
      store.verifyExactQuote({ sourceRef: source.ref, ...proof.organizationExcerpt }),
      store.verifyExactQuote({ sourceRef: source.ref, ...proof.domainExcerpt }),
    ]);
    if (!organizationExact.valid || !domainExact.valid) return rejected(`Proof ${source.ref} does not match immutable source bytes.`, sourceHashes);
    if (!normalizedText(proof.organizationExcerpt.exactQuote).includes(normalizedText(entry.organization))) return rejected(`Proof ${source.ref} does not identify the proposed organization.`, sourceHashes);
    if (!quoteMentionsDomain(proof.domainExcerpt.exactQuote, entry.domain)) return rejected(`Proof ${source.ref} does not identify the proposed domain.`, sourceHashes);
    const domain = sourceDomain(source);
    if (!domain) return rejected(`Proof ${source.ref} has no eligible registrable source domain.`, sourceHashes);
    proofs.push({ source, domain });
  }

  const trustedExternal = proofs.find(({ source, domain }) => domain !== entry.domain
    && (source.sourceAuthority === "FIRST_PARTY_INSTITUTIONAL" || source.sourceAuthority === "INDEPENDENT_PROFESSIONAL"));
  if (trustedExternal) return {
    ...entry,
    status: "VERIFIED",
    verificationMethod: "TRUSTED_EXTERNAL",
    proofSourceRefs: [trustedExternal.source.ref],
    proofSourceHashes: { [trustedExternal.source.ref]: trustedExternal.source.sha256 },
    rejectionReason: null,
  };

  const onDomain = proofs.find(({ domain }) => domain === entry.domain);
  const reciprocal = onDomain && proofs.find(({ source, domain }) => domain !== entry.domain
    && source.independenceGroup !== onDomain.source.independenceGroup
    && (source.sourceAuthority === "DIRECT_WORK" || source.sourceAuthority === "FIRST_PARTY_INSTITUTIONAL" || source.sourceAuthority === "INDEPENDENT_PROFESSIONAL"));
  if (onDomain && reciprocal) return {
    ...entry,
    status: "VERIFIED",
    verificationMethod: "RECIPROCAL",
    proofSourceRefs: [onDomain.source.ref, reciprocal.source.ref].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))),
    proofSourceHashes: { [onDomain.source.ref]: onDomain.source.sha256, [reciprocal.source.ref]: reciprocal.source.sha256 },
    rejectionReason: null,
  };
  return rejected("A domain cannot authenticate itself; provide trusted external or reciprocal proof.", sourceHashes);
}

function emptyRegistry(): OfficialDomainRegistry {
  const base = { schemaVersion: 1 as const, policyVersion: SOURCE_AUTHORITY_POLICY_VERSION, entries: [] };
  return { ...base, registryHash: registryHash(base) };
}

async function readRegistry(root: string): Promise<OfficialDomainRegistry> {
  try { return officialDomainRegistrySchema.parse(JSON.parse(await readFile(join(root, OFFICIAL_DOMAIN_REGISTRY_PATH), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const registry = officialDomainRegistrySchema.parse(JSON.parse(await readFile(join(root, LEGACY_OFFICIAL_DOMAIN_REGISTRY_PATH), "utf8")));
    await atomicJson(join(root, OFFICIAL_DOMAIN_REGISTRY_PATH), registry);
    return registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyRegistry();
  }
}

const registryQueues = new Map<string, Promise<unknown>>();

export async function registerOfficialDomainProposal(root: string, store: FileSourceStore, value: unknown): Promise<OfficialDomainRegistryEntry> {
  const input = officialDomainRegistrationSchema.parse(value);
  let domain: string | null = null;
  let normalizationError: string | null = null;
  try { domain = normalizeOfficialDomain(input.url).domain; }
  catch (error) { normalizationError = error instanceof Error ? error.message : String(error); }
  const id = proposalId({ organization: input.organization, domain, normalizationError, proofs: input.proofs });
  const proposal = { id, organization: input.organization, domain, normalizationError, proofs: input.proofs };
  const path = join(root, OFFICIAL_DOMAIN_REGISTRY_PATH);
  let result: OfficialDomainRegistryEntry | undefined;
  const operation = (registryQueues.get(path) ?? Promise.resolve()).then(async () => {
    const current = await readRegistry(root);
    if (current.registryHash !== registryHash({ schemaVersion: current.schemaVersion, policyVersion: current.policyVersion, entries: current.entries })) throw new Error("Official-domain registry integrity check failed.");
    const existing = current.entries.find((entry) => entry.id === id);
    result = existing ?? await verifyEntry(store, proposal);
    const entries = existing ? current.entries : [...current.entries, result].sort((left, right) => left.id.localeCompare(right.id));
    const base = { schemaVersion: 1 as const, policyVersion: SOURCE_AUTHORITY_POLICY_VERSION, entries };
    await atomicJson(path, { ...base, registryHash: registryHash(base) });
  });
  registryQueues.set(path, operation.catch(() => undefined));
  await operation;
  return result!;
}

export async function readVerifiedOfficialDomainRegistry(root: string, store: FileSourceStore): Promise<{ registry: OfficialDomainRegistry; registryHash: string }> {
  const registry = await readRegistry(root);
  const expectedHash = registryHash({ schemaVersion: registry.schemaVersion, policyVersion: registry.policyVersion, entries: registry.entries });
  if (registry.registryHash !== expectedHash) throw new Error("Official-domain registry integrity check failed.");
  if (registry.policyVersion !== SOURCE_AUTHORITY_POLICY_VERSION) throw new Error("Official-domain registry policy version is stale.");
  for (const entry of registry.entries) {
    const verified = await verifyEntry(store, entryCore(entry));
    if (JSON.stringify(canonicalize(verified)) !== JSON.stringify(canonicalize(entry))) throw new Error(`Official-domain registry verification outcome changed for ${entry.id}.`);
  }
  return { registry, registryHash: expectedHash };
}

function authority(value: string): SourceAuthority {
  if (new Set(["DIRECT_WORK", "FIRST_PARTY_INSTITUTIONAL", "INDEPENDENT_PROFESSIONAL", "SELF_REPRESENTATION", "CONTEXT", "DISCOVERY_ONLY"]).has(value)) return value as SourceAuthority;
  return "CONTEXT";
}

function attestationGroup(source: CapturedSourceMetadata, effectiveAuthority: SourceAuthority, domain: string | undefined): string {
  if (effectiveAuthority === "SELF_REPRESENTATION") return "CANDIDATE_SELF";
  if (effectiveAuthority === "DIRECT_WORK") return source.independenceGroup;
  if ((effectiveAuthority === "FIRST_PARTY_INSTITUTIONAL" || effectiveAuthority === "INDEPENDENT_PROFESSIONAL") && domain) return `domain:${domain}`;
  return source.independenceGroup;
}

export async function buildSourceAuthoritySnapshot(
  store: FileSourceStore,
  registry: OfficialDomainRegistry,
  candidateOwnedDomains: ReadonlySet<string> = new Set(),
): Promise<SourceAuthoritySnapshot> {
  const expectedRegistryHash = registryHash({ schemaVersion: registry.schemaVersion, policyVersion: registry.policyVersion, entries: registry.entries });
  if (registry.registryHash !== expectedRegistryHash || registry.policyVersion !== SOURCE_AUTHORITY_POLICY_VERSION) throw new Error("Cannot build authority snapshot from an unverified registry.");
  for (const entry of registry.entries) {
    const verified = await verifyEntry(store, entryCore(entry));
    if (JSON.stringify(canonicalize(verified)) !== JSON.stringify(canonicalize(entry))) throw new Error(`Cannot build authority snapshot from changed verification outcome ${entry.id}.`);
  }
  const entriesByDomain = new Map(registry.entries.filter((entry) => entry.status === "VERIFIED" && entry.domain).map((entry) => [entry.domain!, entry]));
  const sources = (await store.list()).map((source) => {
    const capturedAuthority = authority(source.sourceAuthority);
    const domain = sourceDomain(source);
    const matched = capturedAuthority === "CONTEXT" && domain ? entriesByDomain.get(domain) : undefined;
    const candidateOwned = capturedAuthority === "CONTEXT" && domain ? candidateOwnedDomains.has(domain) : false;
    const effectiveAuthority: SourceAuthority = capturedAuthority !== "CONTEXT"
      ? capturedAuthority
      : matched
        ? "FIRST_PARTY_INSTITUTIONAL"
        : candidateOwned
          ? "SELF_REPRESENTATION"
          : "CONTEXT";
    return {
      sourceRef: source.ref,
      sourceHash: source.sha256,
      capturedAuthority,
      effectiveAuthority,
      matchedRegistryEntry: matched?.id ?? null,
      verificationMethod: matched?.verificationMethod ?? null,
      proofSourceRefs: matched?.proofSourceRefs ?? [],
      registryHash: expectedRegistryHash,
      policyVersion: SOURCE_AUTHORITY_POLICY_VERSION,
      attestationGroup: attestationGroup(source, effectiveAuthority, domain),
    };
  }).sort((left, right) => Number(left.sourceRef.slice(1)) - Number(right.sourceRef.slice(1)));
  return sourceAuthoritySnapshotSchema.parse({ schemaVersion: 1, policyVersion: SOURCE_AUTHORITY_POLICY_VERSION, registryHash: expectedRegistryHash, sources });
}

export async function loadSourceAuthority(root: string, store: FileSourceStore): Promise<{ registry: OfficialDomainRegistry; snapshot: SourceAuthoritySnapshot }> {
  const { registry } = await readVerifiedOfficialDomainRegistry(root, store);
  return { registry, snapshot: await buildSourceAuthoritySnapshot(store, registry) };
}
