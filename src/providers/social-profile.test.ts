import assert from "node:assert/strict";
import test from "node:test";

import { socialProfileUrl } from "./executor.ts";

test("Bright Data social collectors receive canonical platform profile URLs", () => {
  assert.equal(socialProfileUrl("X", "@diegor"), "https://x.com/diegor");
  assert.equal(socialProfileUrl("X", "https://twitter.com/diegor"), "https://x.com/diegor");
  assert.equal(socialProfileUrl("INSTAGRAM", "diegor.it"), "https://www.instagram.com/diegor.it/");
  assert.equal(socialProfileUrl("TIKTOK", "@diegor"), "https://www.tiktok.com/@diegor");
  assert.throws(() => socialProfileUrl("X", "not a handle"), /invalid/i);
});
