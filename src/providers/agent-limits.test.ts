import assert from "node:assert/strict";
import test from "node:test";

import { agentToolCeiling } from "./executor.ts";

test("research-agent provider ceilings are enforced independently of the global case budget", () => {
  assert.equal(agentToolCeiling("professional-investigator", "professional.profile"), 2);
  assert.equal(agentToolCeiling("professional-investigator", "web.fetch"), 4);
  assert.equal(agentToolCeiling("github-investigator", "github.rest"), 4);
  assert.equal(agentToolCeiling("web-records-investigator", "web.fetch"), 6);
  assert.equal(agentToolCeiling("social-investigator", "social.profile"), 2);
  assert.equal(agentToolCeiling("lead-investigator", "web.fetch"), undefined);
});
