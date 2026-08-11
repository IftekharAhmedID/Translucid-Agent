export type IndependentAudit = {
  status: "PASSED" | "REPAIR_REQUIRED";
  defects: string[];
};

type Inputs<Draft, Result> = {
  compile: (input: { attempt: 1 | 2; defects?: string[]; previousDraft?: Draft }) => Promise<Draft>;
  validate: (draft: Draft) => Promise<Result>;
  audit: (result: Result, attempt: 1 | 2) => Promise<IndependentAudit>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeWithSingleRepair<Draft, Result>(input: Inputs<Draft, Result>): Promise<{
  draft: Draft;
  result: Result;
  compilerAttempts: 1 | 2;
  auditorAttempts: 1 | 2;
}> {
  let compilerAttempts: 1 | 2 = 1;
  let repairUsed = false;
  let draft: Draft;
  try { draft = await input.compile({ attempt: 1 }); }
  catch (error) {
    repairUsed = true;
    compilerAttempts = 2;
    try { draft = await input.compile({ attempt: 2, defects: [`Compiler schema: ${message(error)}`] }); }
    catch (repairError) { throw new Error(`Compiler schema failed after the single repair: ${message(repairError)}`); }
  }

  let result: Result;
  try { result = await input.validate(draft); }
  catch (error) {
    if (repairUsed) throw new Error(`Deterministic validation failed after the single repair: ${message(error)}`);
    repairUsed = true;
    compilerAttempts = 2;
    const previousDraft = draft;
    try { draft = await input.compile({ attempt: 2, defects: [`Deterministic validation: ${message(error)}`], previousDraft }); }
    catch (repairError) { throw new Error(`Compiler repair failed after deterministic validation: ${message(repairError)}`); }
    try { result = await input.validate(draft); }
    catch (repairError) { throw new Error(`Deterministic validation failed after the single repair: ${message(repairError)}`); }
  }

  const firstAudit = await input.audit(result, 1);
  if (firstAudit.status === "PASSED") return { draft, result, compilerAttempts, auditorAttempts: 1 };
  if (repairUsed) throw new Error(`Independent audit failed after the single repair: ${firstAudit.defects.join("; ") || "unspecified material defect"}.`);

  const previousDraft = draft;
  try { draft = await input.compile({ attempt: 2, defects: firstAudit.defects, previousDraft }); }
  catch (error) { throw new Error(`Audit-directed compiler repair failed: ${message(error)}`); }
  compilerAttempts = 2;
  try { result = await input.validate(draft); }
  catch (error) { throw new Error(`Audit-directed repair failed deterministic validation: ${message(error)}`); }
  const secondAudit = await input.audit(result, 2);
  if (secondAudit.status !== "PASSED") throw new Error(`Independent verification audit failed after the single repair: ${secondAudit.defects.join("; ") || "unspecified material defect"}.`);
  return { draft, result, compilerAttempts, auditorAttempts: 2 };
}
