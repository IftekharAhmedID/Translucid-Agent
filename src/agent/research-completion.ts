export type ResearchCompletionAction = "WAIT" | "CONTINUE" | "FINISH" | "ABORT_AND_FINISH";

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
