import assert from "node:assert/strict";
import test from "node:test";

import { socialProfileUrl } from "./executor.ts";

test("Bright Data social collectors receive canonical platform profile URLs", () => {
  assert.equal(socialProfileUrl("X", "@casey_profile"), "https://x.com/casey_profile");
  assert.equal(socialProfileUrl("X", "https://twitter.com/casey_profile"), "https://x.com/casey_profile");
  assert.equal(socialProfileUrl("INSTAGRAM", "casey.profile"), "https://www.instagram.com/casey.profile/");
  assert.equal(socialProfileUrl("TIKTOK", "@casey_profile"), "https://www.tiktok.com/@casey_profile");
  assert.throws(() => socialProfileUrl("X", "not a handle"), /invalid/i);
});
