import assert from "node:assert/strict";
import test from "node:test";

import { profileHasMaterialField, unwrapLinkdProfileResponse } from "./executor.ts";

test("unwraps a successful LinkdAPI profile response instead of matching a human field label literally", () => {
  const profile = unwrapLinkdProfileResponse({
    success: true,
    message: "Data retrieved successfully",
    data: {
      username: "casey-profile",
      headline: "Principal Software Engineer",
      currentPositions: [{ title: "Principal Software Engineer", companyName: "Organization Alpha" }],
      fullPositions: [{ title: "Principal Software Engineer", companyName: "Organization Alpha" }],
    },
  });

  assert.equal(profile?.username, "casey-profile");
  assert.equal(Array.isArray(profile?.fullPositions), true);
});

test("material-field routing distinguishes identity, current role, history and education", () => {
  const profile = unwrapLinkdProfileResponse({
    success: true,
    data: {
      username: "casey-profile",
      fullName: "Casey Morgan",
      currentPositions: [{ title: "Principal Software Engineer", companyName: "Organization Alpha" }],
      fullPositions: [{ title: "Principal Software Engineer", companyName: "Organization Alpha" }],
      educations: [],
    },
  })!;
  assert.equal(profileHasMaterialField(profile, "IDENTITY"), true);
  assert.equal(profileHasMaterialField(profile, "CURRENT_POSITION"), true);
  assert.equal(profileHasMaterialField(profile, "EMPLOYMENT_HISTORY"), true);
  assert.equal(profileHasMaterialField(profile, "EDUCATION"), false);
});

test("rejects failed or empty LinkdAPI envelopes", () => {
  assert.equal(unwrapLinkdProfileResponse({ success: false, data: {} }), undefined);
  assert.equal(unwrapLinkdProfileResponse({ success: true, data: {} }), undefined);
  assert.equal(unwrapLinkdProfileResponse(null), undefined);
});
