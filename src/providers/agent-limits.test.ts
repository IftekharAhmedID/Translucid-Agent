import assert from "node:assert/strict";
import test from "node:test";

import { agentToolCeiling } from "./executor.ts";

test("research agents do not have tiny per-agent provider ceilings", () => {
  assert.equal(agentToolCeiling("professional-investigator", "professional.profile"), undefined);
  assert.equal(agentToolCeiling("professional-investigator", "web.fetch"), undefined);
  assert.equal(agentToolCeiling("github-investigator", "github.rest"), undefined);
  assert.equal(agentToolCeiling("web-records-investigator", "web.fetch"), undefined);
  assert.equal(agentToolCeiling("social-investigator", "social.profile"), undefined);
  assert.equal(agentToolCeiling("lead-investigator", "web.fetch"), undefined);
});
