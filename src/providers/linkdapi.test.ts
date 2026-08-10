import assert from "node:assert/strict";
import test from "node:test";

import { profileHasMaterialField, unwrapLinkdProfileResponse } from "./executor.ts";

test("unwraps a successful LinkdAPI profile response instead of matching a human field label literally", () => {
  const profile = unwrapLinkdProfileResponse({
    success: true,
    message: "Data retrieved successfully",
    data: {
      username: "diegor",
      headline: "Principal Software Engineer",
      currentPositions: [{ title: "Principal Software Engineer", companyName: "Arm" }],
      fullPositions: [{ title: "Principal Software Engineer", companyName: "Arm" }],
    },
  });

  assert.equal(profile?.username, "diegor");
  assert.equal(Array.isArray(profile?.fullPositions), true);
});

test("material-field routing distinguishes identity, current role, history and education", () => {
  const profile = unwrapLinkdProfileResponse({
    success: true,
    data: {
      username: "diegor",
      fullName: "Diego Russo",
      currentPositions: [{ title: "Principal Software Engineer", companyName: "Arm" }],
      fullPositions: [{ title: "Principal Software Engineer", companyName: "Arm" }],
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
