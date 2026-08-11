import assert from "node:assert/strict";
import test from "node:test";

import { deriveTimelineStates } from "./timeline.ts";

test("timeline distinguishes reported, self-supported, corroborated, and conflicting observations", () => {
  const observations = [
    { id: "reported", artifactId: "a1", field: "title", value: "Engineer", validFrom: "2020-01-01", validTo: "2021-01-01" },
    { id: "self", artifactId: "a2", field: "title", value: "Staff", validFrom: "2021-01-02", validTo: "2022-01-01" },
    { id: "independent", artifactId: "a3", field: "employer", value: "Arm", validFrom: "2020-01-01", validTo: "2022-01-01" },
    { id: "conflict", artifactId: "a4", field: "location", value: "Cambridge", validFrom: "2020-01-01", validTo: "2022-01-01" },
    { id: "conflict-peer", artifactId: "a5", field: "location", value: "London", validFrom: "2021-01-01", validTo: "2023-01-01" },
  ];
  const result = deriveTimelineStates(observations, [
    { artifactId: "a2", relation: "SUPPORTS", sourceAuthority: "SELF_REPRESENTATION", attestationGroup: "CANDIDATE_SELF" },
    { artifactId: "a3", relation: "SUPPORTS", sourceAuthority: "FIRST_PARTY_INSTITUTIONAL", attestationGroup: "domain:arm.com" },
  ]);
  assert.deepEqual(Object.fromEntries(result.map(({ id, timelineState }) => [id, timelineState])), {
    reported: "REPORTED",
    self: "SUPPORTED_SELF",
    independent: "CORROBORATED",
    conflict: "CONFLICTING",
    "conflict-peer": "CONFLICTING",
  });
});
