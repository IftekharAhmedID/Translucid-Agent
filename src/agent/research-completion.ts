export type ResearchCompletionAction = "WAIT" | "CONTINUE" | "FINISH" | "ABORT_AND_FINISH";

export type ResearchProgressInput = {
  questionStates: Array<{ id: string; status: string }>;
  evidenceCount: number;
  observationCount: number;
  successfulProviderCallCount: number;
  researchWave: number;
  fingerprintVersion?: number;
};

export function researchProgressFingerprint(input: ResearchProgressInput): string {
  return JSON.stringify({
    version: input.fingerprintVersion ?? 1,
    questionStates: [...input.questionStates].sort((left, right) => left.id.localeCompare(right.id)),
    evidenceCount: input.evidenceCount,
    observationCount: input.observationCount,
    successfulProviderCallCount: input.successfulProviderCallCount,
    researchWave: input.researchWave,
  });
}

export function researchContinuationAllowed(input: {
  continuationCount: number;
  activeQuestionCount: number;
  durableProgress: boolean;
  unchangedCheckpointCount?: number;
}): boolean {
  const unchanged = input.unchangedCheckpointCount ?? input.continuationCount;
  return input.activeQuestionCount > 0 && unchanged < 2;
}

export function hasDurableResearchIntake(input: { claimCount: number; questionCount: number }): boolean {
  return input.claimCount > 0 && input.questionCount > 0;
}

export function researchCompletionAction(input: {
  totalQuestionCount: number;
  activeQuestionCount: number;
  sessionStatus: "busy" | "retry" | "idle" | undefined;
  readyForContinuation: boolean;
}): ResearchCompletionAction {
  if (input.totalQuestionCount > 0 && input.activeQuestionCount === 0) {
    return input.sessionStatus === "busy" || input.sessionStatus === "retry" ? "ABORT_AND_FINISH" : "FINISH";
  }
  if (input.totalQuestionCount === 0 && input.readyForContinuation && input.sessionStatus === "idle") return "CONTINUE";
  if (input.activeQuestionCount > 0 && input.readyForContinuation && (!input.sessionStatus || input.sessionStatus === "idle")) return "CONTINUE";
  return "WAIT";
}
