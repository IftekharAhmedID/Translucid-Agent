import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  coveragePlanSchema,
  dossierFingerprint,
  mergePacketDossier,
  packetSchema,
  splitClaimPackets,
  validateCoveragePlan,
  validatePacketEvidence,
  validatePacket,
  type CoveragePlan,
  type PacketDossier,
} from "./packet-dossier.ts";
import { FileSourceStore } from "./source-store.ts";

function inputDocument() {
  return {
    pages: [{
      page: 1,
      lines: [
        { line: 1, text: "PROFILE" },
        { line: 2, text: "Principal Engineer at Example Corp" },
        { line: 3, text: "Python, TypeScript" },
      ],
      text: "Ada Lovelace\nPrincipal Engineer at Example Corp\nPython, TypeScript",
    }],
  };
}

function plan(): CoveragePlan {
  return coveragePlanSchema.parse({
    claims: [{
      key: "employment",
      category: "EMPLOYMENT",
      statement: "Ada Lovelace was a Principal Engineer at Example Corp.",
      materiality: "HIGH",
      sourceSpan: { page: 1, lineStart: 2, lineEnd: 2, text: "Principal Engineer at Example Corp" },
      facets: [
        { key: "employer", label: "Employer: Example Corp", materiality: "HIGH" },
        { key: "title", label: "Title: Principal Engineer", materiality: "HIGH" },
      ],
    }],
    coverage: [
      { span: { page: 1, lineStart: 1, lineEnd: 1, text: "PROFILE" }, disposition: "EXCLUDED", reason: "SECTION_HEADING" },
      { span: { page: 1, lineStart: 2, lineEnd: 2, text: "Principal Engineer at Example Corp" }, disposition: "CLAIMED", claimKey: "employment" },
      { span: { page: 1, lineStart: 3, lineEnd: 3, text: "Python, TypeScript" }, disposition: "EXCLUDED", reason: "BARE_SKILL" },
    ],
  });
}

function packet(claimKey = "employment") {
  return packetSchema.parse({
    claims: [{
      claimKey,
      explanation: "The preserved institutional record supports the employer and title.",
      facets: [
        { key: "employer", note: "The source names Example Corp." },
        { key: "title", note: "The source names Principal Engineer." },
      ],
    }],
    evidence: [{
      key: "employment-source",
      claimKey,
      facetKeys: ["employer", "title"],
      relation: "SUPPORTS",
      sourceRef: "S1",
      exactQuote: "Principal Engineer at Example Corp",
      sourceLocation: { path: "records[0].text" },
    }],
  });
}

const summary = {
  professionalIdentity: { status: "RESOLVED", text: "Identity is resolved.", claimKeys: ["employment"], evidenceKeys: ["employment-source"] },
  professionalTimelineSummary: "Employment is supported.",
  timelineClaimKeys: ["employment"],
  timelineEvidenceKeys: ["employment-source"],
  strongestEvidenceByClaim: [{ claimKey: "employment", facetKeys: ["employer", "title"], evidenceKeys: ["employment-source"] }],
  materialInconsistencies: [],
  limitations: [],
};

test("coverage validation requires every non-empty input line and exact spans", () => {
  const validated = validateCoveragePlan(plan(), inputDocument());
  assert.equal(validated.claims.length, 1);

  const missing = structuredClone(plan());
  missing.coverage = missing.coverage.filter((item) => item.span.lineStart !== 3);
  assert.throws(() => validateCoveragePlan(missing, inputDocument()), /line 3/i);

  const mutated = structuredClone(plan());
  mutated.coverage[1]!.span.text = "Principal Engineer at Other Corp";
  assert.throws(() => validateCoveragePlan(mutated, inputDocument()), /does not match/i);

  const omittedClaim = structuredClone(plan());
  omittedClaim.coverage[1] = { span: { page: 1, lineStart: 2, lineEnd: 2, text: "Principal Engineer at Example Corp" }, disposition: "EXCLUDED", reason: "DUPLICATE" };
  assert.throws(() => validateCoveragePlan(omittedClaim, inputDocument()), /DUPLICATE|not represented/i);

  const detachedOutline = structuredClone(plan());
  detachedOutline.claims[0]!.sourceSpan = { page: 1, lineStart: 1, lineEnd: 1, text: "PROFILE" };
  assert.throws(() => validateCoveragePlan(detachedOutline, inputDocument()), /source span.*claimed coverage/i);
});

test("coverage validation rejects a material claim clause without a facet before packet compilation", () => {
  const value = structuredClone(plan());
  value.claims[0]!.statement = "Ada Lovelace was a Principal Engineer at Example Corp and built software using Java and Vanilla JavaScript.";
  assert.throws(() => validateCoveragePlan(value, inputDocument()), /material claim clause|facet/i);
});

test("contact and heading exclusions remain non-claims even when their text contains factual keywords", () => {
  const value = coveragePlanSchema.parse({
    claims: [{ ...plan().claims[0]!, sourceSpan: { page: 1, lineStart: 3, lineEnd: 3, text: "Python, TypeScript" } }],
    coverage: [
      { span: { page: 1, lineStart: 1, lineEnd: 1, text: "Employment History" }, disposition: "EXCLUDED", reason: "SECTION_HEADING" },
      { span: { page: 1, lineStart: 2, lineEnd: 2, text: "Email: engineer@example.com" }, disposition: "EXCLUDED", reason: "CONTACT_DETAIL" },
      { span: { page: 1, lineStart: 3, lineEnd: 3, text: "Python, TypeScript" }, disposition: "CLAIMED", claimKey: "employment" },
    ],
  });
  const input = { pages: [{ page: 1, lines: [{ line: 1, text: "Employment History" }, { line: 2, text: "Email: engineer@example.com" }, { line: 3, text: "Python, TypeScript" }] }] };
  assert.doesNotThrow(() => validateCoveragePlan(value, input));
});

test("packet partitioning is deterministic and caps each packet at five claims", () => {
  const base = plan().claims[0]!;
  const outlines = Array.from({ length: 12 }, (_, index) => ({ ...base, key: `claim-${index}`, statement: `Claim ${index}` }));
  const packets = splitClaimPackets(outlines, 5);
  assert.deepEqual(packets.map((items) => items.length), [5, 5, 2]);
  assert.deepEqual(packets.flat().map(({ key }) => key), outlines.map(({ key }) => key));
});

test("packet validation rejects missing facets and unknown sources", () => {
  const outline = plan().claims;
  assert.doesNotThrow(() => validatePacket(packet(), outline, new Set(["S1"])));

  const missingFacet = structuredClone(packet());
  missingFacet.claims[0]!.facets.pop();
  assert.throws(() => validatePacket(missingFacet, outline, new Set(["S1"])), /facet/i);

  const unknownSource = structuredClone(packet());
  unknownSource.evidence[0]!.sourceRef = "S2";
  assert.throws(() => validatePacket(unknownSource, outline, new Set(["S1"])), /unknown source/i);
});

test("packet evidence validation requires exact immutable source bytes at the declared path", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-packet-evidence-"));
  try {
    const sourceStore = await FileSourceStore.open(root);
    await sourceStore.capture({
      kind: "PROVIDER_RESPONSE",
      provider: "fixture",
      providerRoute: "web.fetch",
      sourceUrl: "https://example.test/record",
      mimeType: "application/json",
      content: { record: { text: "Principal Engineer at Example Corp" } },
      provenance: { immutable: true },
    });
    const value = packet();
    value.evidence[0]!.sourceLocation = { path: "record.text" };
    value.evidence[0]!.exactQuote = "Principal Engineer at Other Corp";
    await assert.rejects(
      () => validatePacketEvidence(value, plan().claims, sourceStore, new Set(["S1"])),
      /exact source path|source location/i,
    );
    value.evidence[0]!.exactQuote = "Principal Engineer at Example Corp";
    assert.doesNotThrow(() => validatePacket(value, plan().claims, new Set(["S1"])));
    await assert.doesNotReject(() => validatePacketEvidence(value, plan().claims, sourceStore, new Set(["S1"])));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merged dossier preserves packet semantics and has a stable fingerprint", () => {
  const coverage = validateCoveragePlan(plan(), inputDocument());
  const dossier = mergePacketDossier(coverage, [packet()], summary, []);
  assert.equal(dossier.claims[0]!.key, "employment");
  assert.equal(dossier.evidence[0]!.sourceRef, "S1");
  assert.equal(dossier.coverage.length, 3);
  const reordered: PacketDossier = structuredClone(dossier);
  reordered.evidence.reverse();
  reordered.coverage.reverse();
  assert.equal(dossierFingerprint(dossier), dossierFingerprint(reordered));
});
