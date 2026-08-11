import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityForRequest,
  decideProfessionalProfileRoute,
  parseHeadlessToolRequest,
  parseToolRequest,
  shouldAllowSocialResearch,
} from "./contracts.ts";

test("headless provider requests contain only network-semantic arguments", () => {
  const parsed = parseHeadlessToolRequest({
    tool: "web.search",
    arguments: { query: "Ada Lovelace analytical engine", mode: "fast" },
  });
  assert.equal(parsed.tool, "web.search");
  assert.equal(parsed.arguments.resultLimit, 5);
  assert.equal(parsed.arguments.highlightQuery, "Ada Lovelace analytical engine");
  assert.equal("questionId" in parsed.arguments, false);

  assert.throws(() => parseHeadlessToolRequest({
    tool: "web.search",
    arguments: {
      query: "Ada Lovelace analytical engine",
      questionId: "11111111-1111-4111-8111-111111111111",
    },
  }));
});

test("tool requests require a durable question and public rationale", () => {
  assert.throws(() =>
    parseToolRequest({
      tool: "web.search",
      arguments: { query: "Ada Lovelace" },
    }),
  );

  const parsed = parseToolRequest({
    tool: "web.search",
    arguments: {
      query: "Ada Lovelace analytical engine",
      questionId: "11111111-1111-4111-8111-111111111111",
      claimIds: ["22222222-2222-4222-8222-222222222222"],
      publicRationale: "Checking a material authorship claim.",
      mode: "fast",
    },
  });
  assert.equal(parsed.tool, "web.search");
  assert.equal(parsed.arguments.resultLimit, 5);
  assert.equal(parsed.arguments.highlightQuery, "Ada Lovelace analytical engine");
});

test("professional profile requests require one normalized material-field enum", () => {
  const parsed = parseToolRequest({
    tool: "professional.profile",
    arguments: {
      questionId: "00000000-0000-4000-8000-000000000001",
      claimIds: [],
      publicRationale: "Resolving the submitted current position claim.",
      username: "Example-Person",
      requiredMaterialField: "CURRENT_POSITION",
    },
  });
  assert.equal(parsed.tool, "professional.profile");
  if (parsed.tool !== "professional.profile") throw new Error("Unexpected parsed tool.");
  assert.equal(parsed.arguments.requiredMaterialField, "CURRENT_POSITION");
  assert.throws(() => parseToolRequest({
    tool: "professional.profile",
    arguments: {
      questionId: "00000000-0000-4000-8000-000000000001",
      claimIds: [],
      publicRationale: "Using an invalid free-form material field.",
      username: "Example-Person",
      requiredMaterialField: "principal title at Acme",
    },
  }));
});

test("a satisfactory LinkdAPI profile blocks Bright Data and PDL escalation", () => {
  assert.equal(
    decideProfessionalProfileRoute({
      linkdAttempted: true,
      linkdValid: true,
      requiredMaterialFieldPresent: true,
      brightAttempted: false,
    }),
    "STOP_SATISFIED",
  );
  assert.equal(
    decideProfessionalProfileRoute({
      linkdAttempted: true,
      linkdValid: false,
      requiredMaterialFieldPresent: false,
      brightAttempted: false,
    }),
    "BRIGHTDATA_ONCE",
  );
  assert.equal(
    decideProfessionalProfileRoute({
      linkdAttempted: true,
      linkdValid: false,
      requiredMaterialFieldPresent: false,
      brightAttempted: true,
    }),
    "STOP_UNRESOLVED",
  );
});

test("social research needs an explicit permitted reason", () => {
  assert.equal(shouldAllowSocialResearch("PROFILE_MIGHT_EXIST"), false);
  assert.equal(shouldAllowSocialResearch("EXPLICIT_SOCIAL_CLAIM"), true);
  assert.equal(shouldAllowSocialResearch("PUBLIC_IDENTITY_CROSS_LINK"), true);
  assert.equal(shouldAllowSocialResearch("MATERIAL_ACTIVITY_QUESTION"), true);
});

test("patent searches use the separately gated PATENTS capability", () => {
  const request = parseToolRequest({
    tool: "public_records.search",
    arguments: {
      questionId: "00000000-0000-4000-8000-000000000001",
      claimIds: [],
      publicRationale: "Checking a material synthetic patent claim.",
      recordType: "PATENT",
      query: "synthetic patent",
    },
  });
  assert.equal(capabilityForRequest(request), "PATENTS");
});

test("repository inspection accepts bounded GitHub coordinates, not arbitrary clone URLs", () => {
  const request = parseToolRequest({
    tool: "github.clone",
    arguments: {
      questionId: "00000000-0000-4000-8000-000000000001",
      claimIds: [],
      publicRationale: "Inspecting public patches for a material contribution claim.",
      repository: "openai/codex",
      authorHint: "Synthetic Candidate",
    },
  });
  assert.equal(request.tool, "github.clone");
  assert.throws(() => parseToolRequest({
    tool: "github.clone",
    arguments: {
      questionId: "00000000-0000-4000-8000-000000000001",
      claimIds: [],
      publicRationale: "Attempting an arbitrary repository location.",
      repository: "https://example.test/owner/repo",
    },
  }));
});
