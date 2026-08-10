import assert from "node:assert/strict";
import test from "node:test";

import { researchCompletionAction, researchContinuationAllowed } from "./research-completion.ts";

test("a terminal durable frontier finishes immediately even when OpenCode remains busy", () => {
  assert.equal(researchCompletionAction({ totalQuestionCount: 12, activeQuestionCount: 0, sessionStatus: "busy", readyForContinuation: false }), "ABORT_AND_FINISH");
  assert.equal(researchCompletionAction({ totalQuestionCount: 12, activeQuestionCount: 0, sessionStatus: "idle", readyForContinuation: true }), "FINISH");
});

test("an active frontier waits while busy and continues only after the session becomes idle", () => {
  assert.equal(researchCompletionAction({ totalQuestionCount: 12, activeQuestionCount: 3, sessionStatus: "busy", readyForContinuation: false }), "WAIT");
  assert.equal(researchCompletionAction({ totalQuestionCount: 12, activeQuestionCount: 3, sessionStatus: "idle", readyForContinuation: true }), "CONTINUE");
});

test("an empty pre-intake frontier is not mistaken for completed research", () => {
  assert.equal(researchCompletionAction({ totalQuestionCount: 0, activeQuestionCount: 0, sessionStatus: "busy", readyForContinuation: false }), "WAIT");
  assert.equal(researchCompletionAction({ totalQuestionCount: 0, activeQuestionCount: 0, sessionStatus: "idle", readyForContinuation: false }), "WAIT");
});

test("an idle empty intake receives an orchestrator-controlled continuation opportunity", () => {
  assert.equal(researchCompletionAction({ totalQuestionCount: 0, activeQuestionCount: 0, sessionStatus: "idle", readyForContinuation: true }), "CONTINUE");
});

test("active research receives at most one continuation without durable progress", () => {
  assert.equal(researchContinuationAllowed({ continuationCount: 0, activeQuestionCount: 3, durableProgress: false }), true);
  assert.equal(researchContinuationAllowed({ continuationCount: 1, activeQuestionCount: 3, durableProgress: false }), false);
  assert.equal(researchContinuationAllowed({ continuationCount: 0, activeQuestionCount: 0, durableProgress: true }), false);
});
