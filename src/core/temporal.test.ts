import assert from "node:assert/strict";
import test from "node:test";

import { compareTemporalObservations } from "./temporal.ts";

test("older and newer observations are progression, not conflict", () => {
  assert.equal(compareTemporalObservations(
    { field: "impact", value: 700, validFrom: "2022-01-01T00:00:00Z", validTo: "2022-12-31T00:00:00Z" },
    { field: "impact", value: 1400, validFrom: "2023-01-01T00:00:00Z", validTo: "2023-12-31T00:00:00Z" },
  ), "PROGRESSION");
});

test("overlapping and same-date observations retain distinct conflict signals", () => {
  assert.equal(compareTemporalObservations(
    { field: "impact", value: 700, validFrom: "2022-01-01T00:00:00Z", validTo: "2023-06-01T00:00:00Z" },
    { field: "impact", value: 1400, validFrom: "2023-01-01T00:00:00Z", validTo: "2023-12-31T00:00:00Z" },
  ), "OVERLAPPING");
  assert.equal(compareTemporalObservations(
    { field: "title", value: "Staff", validFrom: "2024-01-01T00:00:00Z" },
    { field: "title", value: "Principal", validFrom: "2024-01-01T00:00:00Z" },
  ), "SAME_TIME");
});

test("undated differences remain unknown", () => {
  assert.equal(compareTemporalObservations({ field: "title", value: "Staff" }, { field: "title", value: "Principal" }), "UNKNOWN");
});
