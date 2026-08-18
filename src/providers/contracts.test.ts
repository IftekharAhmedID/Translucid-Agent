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
    arguments: { query: "Casey Morgan Project Atlas", mode: "fast" },
  });
  assert.equal(parsed.tool, "web.search");
  assert.equal(parsed.arguments.resultLimit, 10);
  assert.equal(parsed.arguments.highlightQuery, undefined);
  assert.equal("questionId" in parsed.arguments, false);

  assert.throws(() => parseHeadlessToolRequest({
    tool: "web.search",
    arguments: {
      query: "Casey Morgan Project Atlas",
      questionId: "11111111-1111-4111-8111-111111111111",
    },
  }));
});

test("web search exposes bounded Exa modes with an auto default", () => {
  const base = { query: "Casey Morgan Project Atlas" };
  for (const [mode, expected] of [[undefined, "auto"], ["fast", "fast"], ["auto", "auto"], ["deep", "deep"], ["deep-reasoning", "deep-reasoning"]] as const) {
    const parsed = parseHeadlessToolRequest({ tool: "web.search", arguments: { ...base, ...(mode ? { mode } : {}) } });
    if (parsed.tool !== "web.search") throw new Error("Unexpected parsed tool.");
    assert.equal(parsed.arguments.mode, expected);
  }

  const standard = parseToolRequest({
    tool: "web.search",
    arguments: {
      ...base,
      questionId: "11111111-1111-4111-8111-111111111111",
      claimIds: [],
      publicRationale: "Checking a material authorship claim.",
    },
  });
  if (standard.tool !== "web.search") throw new Error("Unexpected parsed tool.");
  assert.equal(standard.arguments.mode, "auto");

  for (const mode of ["instant", "bogus"]) {
    assert.throws(() => parseHeadlessToolRequest({ tool: "web.search", arguments: { ...base, mode } }));
  }
});

test("web search normalizes a bounded official-domain filter", () => {
  const parsed = parseHeadlessToolRequest({
    tool: "web.search",
    arguments: {
      query: "Exact Candidate Name",
      includeDomains: ["Directory.Example.EDU/faculty", "*.example.edu", "directory.example.edu/faculty"],
    },
  });
  assert.equal(parsed.tool, "web.search");
  assert.deepEqual(parsed.arguments.includeDomains, ["*.example.edu", "directory.example.edu/faculty"]);
  for (const includeDomains of [[], ["https://example.edu"], ["example.edu?query=x"], ["not a hostname"], Array.from({ length: 11 }, (_, index) => `d${index}.example.edu`)]) {
    assert.throws(() => parseHeadlessToolRequest({ tool: "web.search", arguments: { query: "Exact Candidate Name", includeDomains } }));
  }
});

test("web search restricts deep material routes and normalizes UTC date bounds", () => {
  const deepArguments = {
    query: "Exact Candidate Name",
    mode: "deep" as const,
    additionalQueries: ["Exact Candidate Name Arm", "Exact Candidate Name CPython"],
    includeDomains: ["Arm.COM", "python.org"],
    excludeDomains: ["LinkedIn.COM", "candidate.example"],
    startPublishedDate: "2020-01-02T03:04:05Z",
    endPublishedDate: "2021-01-02T03:04:05.123Z",
  };
  const headless = parseHeadlessToolRequest({ tool: "web.search", arguments: deepArguments });
  if (headless.tool !== "web.search") throw new Error("Unexpected parsed tool.");
  assert.deepEqual(headless.arguments.additionalQueries, ["Exact Candidate Name Arm", "Exact Candidate Name CPython"]);
  assert.deepEqual(headless.arguments.excludeDomains, ["candidate.example", "linkedin.com"]);
  assert.equal(headless.arguments.startPublishedDate, "2020-01-02T03:04:05.000Z");
  assert.equal(headless.arguments.endPublishedDate, "2021-01-02T03:04:05.123Z");

  const standard = parseToolRequest({
    tool: "web.search",
    arguments: {
      ...deepArguments,
      questionId: "11111111-1111-4111-8111-111111111111",
      claimIds: [],
      publicRationale: "Checking a material professional-history route.",
    },
  });
  if (standard.tool !== "web.search") throw new Error("Unexpected parsed tool.");
  assert.deepEqual(standard.arguments, { ...headless.arguments, questionId: "11111111-1111-4111-8111-111111111111", claimIds: [], publicRationale: "Checking a material professional-history route." });

  const invalid = [
    { mode: "auto", additionalQueries: ["Alternative route"] },
    { mode: "fast", additionalQueries: ["Alternative route"] },
    { mode: "deep", additionalQueries: [] },
    { mode: "deep", additionalQueries: Array.from({ length: 7 }, (_, index) => `Alternative route ${index}`) },
    { mode: "deep", additionalQueries: [" exact   candidate name "] },
    { includeDomains: ["example.edu"], excludeDomains: ["Example.EDU"] },
    { includeDomains: ["*.example.edu"], excludeDomains: ["team.example.edu"] },
    { startPublishedDate: "2023-01-01T00:00:00+00:00" },
    { startPublishedDate: "2023-02-30T00:00:00.000Z" },
    { startPublishedDate: "2024-01-01T00:00:00.000Z", endPublishedDate: "2023-01-01T00:00:00.000Z" },
  ];
  for (const arguments_ of invalid) assert.throws(() => parseHeadlessToolRequest({ tool: "web.search", arguments: { query: "Exact Candidate Name", ...arguments_ } }));
});

test("tool requests require a durable question and public rationale", () => {
  assert.throws(() =>
    parseToolRequest({
      tool: "web.search",
      arguments: { query: "Casey Morgan" },
    }),
  );

  const parsed = parseToolRequest({
    tool: "web.search",
    arguments: {
      query: "Casey Morgan Project Atlas",
      questionId: "11111111-1111-4111-8111-111111111111",
      claimIds: ["22222222-2222-4222-8222-222222222222"],
      publicRationale: "Checking a material authorship claim.",
      mode: "fast",
    },
  });
  assert.equal(parsed.tool, "web.search");
  assert.equal(parsed.arguments.resultLimit, 10);
  assert.equal(parsed.arguments.highlightQuery, undefined);
});

test("web search preserves explicit highlight queries and web fetch keeps paired subpage controls", () => {
  const highlighted = parseHeadlessToolRequest({ tool: "web.search", arguments: { query: "Casey Morgan", highlightQuery: "Principal Engineer" } });
  if (highlighted.tool !== "web.search") throw new Error("Unexpected parsed tool.");
  assert.equal(highlighted.arguments.highlightQuery, "Principal Engineer");
  const paired = parseHeadlessToolRequest({ tool: "web.fetch", arguments: { url: "https://example.test/hub", subpages: 3, subpageTarget: ["release", "author"] } });
  if (paired.tool !== "web.fetch") throw new Error("Unexpected parsed tool.");
  assert.equal(paired.arguments.subpages, 3);
  assert.deepEqual(paired.arguments.subpageTarget, ["release", "author"]);
  for (const arguments_ of [{ subpages: 3 }, { subpageTarget: ["release"] }, { subpages: 0, subpageTarget: ["release"] }, { subpages: 11, subpageTarget: ["release"] }, { subpages: 3, subpageTarget: [] }]) {
    assert.throws(() => parseHeadlessToolRequest({ tool: "web.fetch", arguments: { url: "https://example.test/hub", ...arguments_ } }));
  }
  const discoveryFetch = parseHeadlessToolRequest({ tool: "web.fetch", arguments: { discoveryRef: "S9" } });
  if (discoveryFetch.tool !== "web.fetch") throw new Error("Unexpected tool.");
  assert.equal(discoveryFetch.arguments.discoveryRef, "S9");
});

test("web search exposes safe freshness, category, and deep-focus controls", () => {
  const parsed = parseHeadlessToolRequest({
    tool: "web.search",
    arguments: {
      query: "Current Principal Engineer",
      mode: "deep",
      category: "publication",
      deepFocus: "Find an original institutional record for the exact employment transition.",
      maxAgeHours: 24,
      livecrawlTimeout: 12_000,
    },
  });
  if (parsed.tool !== "web.search") throw new Error("Unexpected tool.");
  assert.equal(parsed.arguments.maxAgeHours, 24);
  assert.equal(parsed.arguments.livecrawlTimeout, 12_000);
  for (const arguments_ of [
    { category: "people", includeDomains: ["example.com"] },
    { category: "people", startPublishedDate: "2024-01-01T00:00:00Z" },
    { category: "company", excludeDomains: ["example.com"] },
    { livecrawlTimeout: 12_000 },
    { maxAgeHours: -1, livecrawlTimeout: 12_000 },
    { mode: "auto", deepFocus: "not a deep route" },
    { mode: "deep-lite", additionalQueries: ["orthogonal route"] },
  ]) assert.throws(() => parseHeadlessToolRequest({ tool: "web.search", arguments: { query: "Candidate", ...arguments_ } }));
});

test("web search batch requires two to six distinct ordinary searches", () => {
  const parsed = parseHeadlessToolRequest({
    tool: "web.search.batch",
    arguments: { searches: [{ query: "Candidate employer" }, { query: "Candidate project" }] },
  });
  assert.equal(parsed.tool, "web.search.batch");
  assert.equal(parsed.arguments.searches.length, 2);
  for (const searches of [[], [{ query: "one" }], Array.from({ length: 7 }, (_, index) => ({ query: `query ${index}` })), [{ query: "same" }, { query: " same " }]]) {
    assert.throws(() => parseHeadlessToolRequest({ tool: "web.search.batch", arguments: { searches } }));
  }
});

test("web fetch accepts optional claim focus without requiring it", () => {
  const focused = parseHeadlessToolRequest({ tool: "web.fetch", arguments: { url: "https://example.test/record", focus: "employment date" } });
  const unfocused = parseHeadlessToolRequest({ tool: "web.fetch", arguments: { url: "https://example.test/record" } });
  assert.equal(focused.tool, "web.fetch");
  if (focused.tool !== "web.fetch" || unfocused.tool !== "web.fetch") throw new Error("Unexpected parsed tool.");
  assert.equal(focused.arguments.focus, "employment date");
  assert.equal(unfocused.arguments.focus, undefined);
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
