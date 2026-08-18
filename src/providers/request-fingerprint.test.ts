import assert from "node:assert/strict";
import test from "node:test";

import { canonicalNetworkArguments, providerRequestFingerprint } from "./request-fingerprint.ts";

test("provider fingerprints ignore question, claim, agent and rationale metadata", () => {
  const first = providerRequestFingerprint("linkdapi.profile", {
    username: " Casey_Profile ",
    requiredMaterialField: "IDENTITY",
    questionId: "question-a",
    claimIds: ["claim-a"],
    publicRationale: "First rationale",
  });
  const second = providerRequestFingerprint("linkdapi.profile", {
    username: "casey_profile",
    requiredMaterialField: "EDUCATION",
    questionId: "question-b",
    claimIds: ["claim-b"],
    publicRationale: "Second rationale",
  });
  assert.equal(first, second);
});

test("canonical network arguments normalize URLs and recursively sort JSON", () => {
  assert.deepEqual(canonicalNetworkArguments({
    url: "HTTPS://Example.COM:443/path#fragment",
    variables: { z: 1, a: { d: 2, c: 1 } },
  }), {
    url: "https://example.com/path",
    variables: { a: { c: 1, d: 2 }, z: 1 },
  });
});

test("GraphQL content is preserved except outer whitespace while variables are sorted", () => {
  const first = providerRequestFingerprint("github.graphql", { query: "  query X { viewer { login } }  ", variables: { b: 2, a: 1 } });
  const second = providerRequestFingerprint("github.graphql", { query: "query X { viewer { login } }", variables: { a: 1, b: 2 } });
  assert.equal(first, second);
});

test("domain-restricted searches have distinct provider fingerprints", () => {
  const unrestricted = providerRequestFingerprint("exa.search", { query: "Exact Candidate Name" });
  const restricted = providerRequestFingerprint("exa.search", { query: "Exact Candidate Name", includeDomains: ["example.edu"] });
  assert.notEqual(unrestricted, restricted);
});

test("material-route controls alter Exa request fingerprints", () => {
  const base = { query: "Exact Candidate Name", type: "deep" };
  const fingerprint = providerRequestFingerprint("exa.search", base);
  for (const arguments_ of [
    { ...base, additionalQueries: ["Exact Candidate Name Arm"] },
    { ...base, excludeDomains: ["linkedin.com"] },
    { ...base, startPublishedDate: "2020-01-01T00:00:00.000Z" },
    { ...base, endPublishedDate: "2021-01-01T00:00:00.000Z" },
  ]) assert.notEqual(providerRequestFingerprint("exa.search", arguments_), fingerprint);
});

test("highlight omission and explicit highlights produce distinct Exa payload fingerprints", () => {
  const omitted = providerRequestFingerprint("exa.search", { query: "Exact Candidate Name", contents: { highlights: true } });
  const explicit = providerRequestFingerprint("exa.search", { query: "Exact Candidate Name", contents: { highlights: { query: "Principal Engineer", maxCharacters: 1_200 } } });
  assert.notEqual(omitted, explicit);
});

test("bounded subpage controls are part of the Exa contents fingerprint", () => {
  const base = providerRequestFingerprint("exa.contents", { urls: ["https://example.test/hub"], text: true, highlights: true });
  const bounded = providerRequestFingerprint("exa.contents", { urls: ["https://example.test/hub"], text: true, highlights: true, subpages: 3, subpageTarget: ["release"] });
  assert.notEqual(base, bounded);
});
