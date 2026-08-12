import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDossierMatchesDraft,
  dossierFingerprint,
  parseEvidenceDossier,
  type DossierRecord,
} from "./dossier.ts";
import type { InvestigationDraft } from "./result-contract.ts";

const summary: InvestigationDraft["summary"] = {
  professionalIdentity: {
    status: "RESOLVED",
    text: "The public records identify the same professional.",
    claimKeys: ["employment"],
    evidenceKeys: ["employment-title"],
  },
  professionalTimelineSummary: "The employment is reported for 2020 through 2024.",
  timelineClaimKeys: ["employment"],
  timelineEvidenceKeys: ["employment-title"],
  strongestEvidenceByClaim: [{
    claimKey: "employment",
    facetKeys: ["title"],
    evidenceKeys: ["employment-title"],
  }],
  materialInconsistencies: [],
  limitations: ["Only public professional sources were reviewed."],
};

const draft: InvestigationDraft = {
  summary,
  claims: [{
    key: "employment",
    category: "EMPLOYMENT",
    statement: "Ada Example worked as a Staff Engineer at Example Corp.",
    materiality: "HIGH",
    sourceSpan: { page: 1, text: "Staff Engineer, Example Corp" },
    explanation: "The cited source states the title and employer.",
    facets: [{
      key: "title",
      label: "Title: Staff Engineer",
      materiality: "HIGH",
      status: "SUPPORTED",
      note: "The title appears in the cited source.",
    }],
  }],
  evidence: [{
    key: "employment-title",
    claimKey: "employment",
    facetKeys: ["title"],
    relation: "SUPPORTS",
    sourceRef: "S1",
    exactQuote: "Staff Engineer",
    sourceLocation: { path: "experience[0].title" },
  }],
  timeline: [{
    label: "Example Corp employment",
    validFrom: "2020",
    validTo: "2024",
    claimKeys: ["employment"],
    evidenceKeys: ["employment-title"],
  }],
};

function records(): DossierRecord[] {
  return [
    {
      type: "TL_CLAIM",
      value: {
        key: "employment",
        category: "EMPLOYMENT",
        statement: "Ada Example worked as a Staff Engineer at Example Corp.",
        materiality: "HIGH",
        sourceSpan: { page: 1, text: "Staff Engineer, Example Corp" },
        explanation: "The cited source states the title and employer.",
      },
    },
    {
      type: "TL_FACET",
      value: {
        claimKey: "employment",
        key: "title",
        label: "Title: Staff Engineer",
        materiality: "HIGH",
        note: "The title appears in the cited source.",
      },
    },
    {
      type: "TL_EVIDENCE",
      value: {
        key: "employment-title",
        claimKey: "employment",
        facetKeys: ["title"],
        relation: "SUPPORTS",
        sourceRef: "S1",
        exactQuote: "Staff Engineer",
        sourceLocation: { path: "experience[0].title" },
      },
    },
    { type: "TL_SUMMARY", value: structuredClone(summary) },
    { type: "TL_TIMELINE", value: structuredClone(draft.timeline[0]!) },
    {
      type: "TL_COVERAGE",
      value: {
        assertion: "Staff Engineer at Example Corp",
        sourceSpan: { page: 1, text: "Staff Engineer, Example Corp" },
        disposition: "CLAIMED",
        claimKey: "employment",
      },
    },
  ];
}

function dossierText(items = records()): string {
  return [
    "# Evidence dossier",
    "",
    "This prose is intentionally ignored by the record parser.",
    ...items.map(({ type, value }) => `${type} ${JSON.stringify(value)}`),
    "",
  ].join("\n");
}

test("parses the six dossier record types and accepts a lossless structured encoding", () => {
  const inventory = parseEvidenceDossier(dossierText(), new Set(["S1"]));
  assert.equal(inventory.claims.length, 1);
  assert.equal(inventory.coverage.length, 1);
  assert.doesNotThrow(() => assertDossierMatchesDraft(inventory, draft));
});

test("record order and set-like key order do not change the semantic fingerprint", () => {
  const reordered = records().reverse();
  const summaryRecord = reordered.find((record) => record.type === "TL_SUMMARY");
  assert.ok(summaryRecord?.type === "TL_SUMMARY");
  summaryRecord.value.professionalIdentity.claimKeys.reverse();
  summaryRecord.value.professionalIdentity.evidenceKeys.reverse();

  const left = parseEvidenceDossier(dossierText(), new Set(["S1"]));
  const right = parseEvidenceDossier(dossierText(reordered), new Set(["S1"]));
  assert.equal(dossierFingerprint(left), dossierFingerprint(right));
});

test("detects mutations to model-authored claim, facet, evidence, summary, and timeline semantics", () => {
  const mutations: Array<[string, (value: InvestigationDraft) => void]> = [
    ["claim", (value) => { value.claims[0]!.statement = "Mutated statement"; }],
    ["facet", (value) => { value.claims[0]!.facets[0]!.label = "Mutated facet"; }],
    ["evidence", (value) => { value.evidence[0]!.exactQuote = "Mutated quote"; }],
    ["summary", (value) => { value.summary.professionalTimelineSummary = "Mutated summary"; }],
    ["timeline", (value) => { value.timeline[0]!.validTo = "2025"; }],
  ];
  const inventory = parseEvidenceDossier(dossierText(), new Set(["S1"]));

  for (const [label, mutate] of mutations) {
    const changed = structuredClone(draft);
    mutate(changed);
    assert.throws(() => assertDossierMatchesDraft(inventory, changed), new RegExp(label, "i"));
  }
});

test("rejects duplicate keys, dangling references, invented sources, and invalid coverage", () => {
  assert.throws(
    () => parseEvidenceDossier(dossierText([...records(), records()[0]!]), new Set(["S1"])),
    /duplicate claim key/i,
  );

  const dangling = records();
  const evidence = dangling.find((record) => record.type === "TL_EVIDENCE");
  assert.ok(evidence?.type === "TL_EVIDENCE");
  evidence.value.facetKeys = ["unknown"];
  assert.throws(() => parseEvidenceDossier(dossierText(dangling), new Set(["S1"])), /unknown facet/i);

  assert.throws(() => parseEvidenceDossier(dossierText(), new Set(["S2"])), /unknown source/i);

  const danglingSummary = records();
  const summaryItem = danglingSummary.find((record) => record.type === "TL_SUMMARY");
  assert.ok(summaryItem?.type === "TL_SUMMARY");
  summaryItem.value.timelineEvidenceKeys = ["unknown"];
  assert.throws(() => parseEvidenceDossier(dossierText(danglingSummary), new Set(["S1"])), /summary references unknown evidence/i);

  const excluded = records();
  const coverage = excluded.find((record) => record.type === "TL_COVERAGE");
  assert.ok(coverage?.type === "TL_COVERAGE");
  coverage.value = {
    assertion: "A low-materiality assertion",
    sourceSpan: { text: "minor hobby" },
    disposition: "EXCLUDED_LOW_MATERIALITY",
    reason: "",
  };
  assert.throws(() => parseEvidenceDossier(dossierText(excluded), new Set(["S1"])), /reason/i);
});

test("rejects unknown TL markers instead of silently ignoring them", () => {
  assert.throws(
    () => parseEvidenceDossier(`${dossierText()}TL_INVENTED {"value":true}\n`, new Set(["S1"])),
    /unknown dossier marker/i,
  );
});
