export type IndependentAudit = {
  status: "PASSED" | "REPAIR_REQUIRED";
  defects: string[];
};

type Inputs<Dossier, Draft, Result> = {
  createDossier: (input: {
    attempt: 1 | 2;
    defects?: string[];
    previousDossier?: Dossier;
  }) => Promise<Dossier>;
  encode: (input: {
    attempt: 1 | 2;
    dossier: Dossier;
    defects?: string[];
    previousDraft?: Draft;
  }) => Promise<Draft>;
  validateEncoding: (dossier: Dossier, draft: Draft) => void | Promise<void>;
  validateResult: (draft: Draft) => Promise<Result>;
  audit: (result: Result, dossier: Dossier, attempt: 1 | 2) => Promise<IndependentAudit>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function materialDefects(audit: IndependentAudit): string {
  return audit.defects.join("; ") || "unspecified material defect";
}

export async function finalizeWithSingleRepair<Dossier, Draft, Result>(input: Inputs<Dossier, Draft, Result>): Promise<{
  dossier: Dossier;
  draft: Draft;
  result: Result;
  compilerAttempts: 1 | 2;
  auditorAttempts: 1 | 2;
}> {
  let repairUsed = false;
  let compilerAttempts: 1 | 2 = 1;
  let dossier: Dossier;

  try {
    dossier = await input.createDossier({ attempt: 1 });
  } catch (error) {
    repairUsed = true;
    compilerAttempts = 2;
    try {
      dossier = await input.createDossier({ attempt: 2, defects: [`Dossier validation: ${message(error)}`] });
    } catch (repairError) {
      throw new Error(`Dossier validation failed after the single repair: ${message(repairError)}`);
    }
  }

  const encodeFresh = async (attempt: 1 | 2, currentDossier: Dossier): Promise<Draft> => {
    let encoded: Draft;
    try {
      encoded = await input.encode({ attempt, dossier: currentDossier });
    } catch (error) {
      throw new Error(`Encoder schema/output: ${message(error)}`);
    }
    try {
      await input.validateEncoding(currentDossier, encoded);
    } catch (error) {
      throw new Error(`Encoding losslessness: ${message(error)}`);
    }
    return encoded;
  };

  let draft: Draft;
  let encodingValidated = false;
  try {
    draft = await input.encode({ attempt: repairUsed ? 2 : 1, dossier });
  } catch (error) {
    if (repairUsed) throw new Error(`Encoding failed after the single repair: Encoder schema/output: ${message(error)}`);
    repairUsed = true;
    compilerAttempts = 2;
    try {
      draft = await input.encode({ attempt: 2, dossier, defects: [`Encoder schema/output: ${message(error)}`] });
      await input.validateEncoding(dossier, draft);
      encodingValidated = true;
    } catch (repairError) {
      throw new Error(`Encoding failed after the single repair: ${message(repairError)}`);
    }
  }
  if (!encodingValidated) {
    try {
      await input.validateEncoding(dossier, draft);
    } catch (error) {
      if (repairUsed) throw new Error(`Encoding failed after the single repair: Encoding losslessness: ${message(error)}`);
      repairUsed = true;
      compilerAttempts = 2;
      const previousDraft = draft;
      try {
        draft = await input.encode({ attempt: 2, dossier, defects: [`Encoding losslessness: ${message(error)}`], previousDraft });
        await input.validateEncoding(dossier, draft);
      } catch (repairError) {
        throw new Error(`Encoding failed after the single repair: ${message(repairError)}`);
      }
    }
  }

  const repairDossierAndEncode = async (defects: string[]): Promise<{ dossier: Dossier; draft: Draft }> => {
    let repairedDossier: Dossier;
    try {
      repairedDossier = await input.createDossier({ attempt: 2, defects, previousDossier: dossier });
    } catch (error) {
      throw new Error(`Dossier repair failed: ${message(error)}`);
    }
    let repairedDraft: Draft;
    try {
      repairedDraft = await encodeFresh(2, repairedDossier);
    } catch (error) {
      throw new Error(`Fresh encoding after dossier repair failed: ${message(error)}`);
    }
    return { dossier: repairedDossier, draft: repairedDraft };
  };

  let result: Result;
  try {
    result = await input.validateResult(draft);
  } catch (error) {
    if (repairUsed) throw new Error(`Deterministic validation failed after the single repair: ${message(error)}`);
    repairUsed = true;
    compilerAttempts = 2;
    ({ dossier, draft } = await repairDossierAndEncode([`Deterministic validation: ${message(error)}`]));
    try {
      result = await input.validateResult(draft);
    } catch (repairError) {
      throw new Error(`Deterministic validation failed after the single repair: ${message(repairError)}`);
    }
  }

  const firstAudit = await input.audit(result, dossier, 1);
  if (firstAudit.status === "PASSED") return { dossier, draft, result, compilerAttempts, auditorAttempts: 1 };
  if (repairUsed) throw new Error(`Independent audit failed after the single repair: ${materialDefects(firstAudit)}.`);

  repairUsed = true;
  compilerAttempts = 2;
  ({ dossier, draft } = await repairDossierAndEncode(firstAudit.defects));
  try {
    result = await input.validateResult(draft);
  } catch (error) {
    throw new Error(`Audit-directed repair failed deterministic validation: ${message(error)}`);
  }
  const secondAudit = await input.audit(result, dossier, 2);
  if (secondAudit.status !== "PASSED") {
    throw new Error(`Independent verification audit failed after the single repair: ${materialDefects(secondAudit)}.`);
  }
  return { dossier, draft, result, compilerAttempts, auditorAttempts: 2 };
}
