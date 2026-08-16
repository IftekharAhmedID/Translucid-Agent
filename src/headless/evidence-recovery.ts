import { mkdir, open, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { FileSourceStore } from "./source-store.ts";

export type EvidenceGoldSource = {
  sourceRef: string;
  recoveryQueries: string[];
};

export type EvidenceRecoverySourceResult = {
  sourceRef: string;
  captured: boolean;
  recoverable: boolean;
  correctlyUtilized: boolean;
  recoveryPath: "MEMO" | "LEDGER" | "INDEX" | "NONE";
};

export type EvidenceRecoveryReport = {
  schemaVersion: 1;
  availableGoldSources: number;
  capturedGoldSources: number;
  recoverableCapturedGoldSources: number;
  correctlyUtilizedRecoverableGoldSources: number;
  sources: EvidenceRecoverySourceResult[];
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceRefsFromText(value: string): Set<string> {
  return new Set([...value.matchAll(/\bS([1-9]\d*)\b/g)].map((match) => `S${match[1]}`));
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${sha256(Buffer.from(`${Date.now()}-${Math.random()}`))}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function evaluateEvidenceRecovery(input: {
  sourceStore: FileSourceStore;
  goldSources: EvidenceGoldSource[];
  encounteredSourceRefs?: Iterable<string>;
  memos?: string[];
  ledgerSourceRefs?: Iterable<string>;
  utilizedSourceRefs?: Iterable<string>;
  rejectedSourceRefs?: Iterable<string>;
}): Promise<EvidenceRecoveryReport> {
  const memoRefs = new Set((input.memos ?? []).flatMap((memo) => [...sourceRefsFromText(memo)]));
  const encounteredRefs = input.encounteredSourceRefs ? new Set(input.encounteredSourceRefs) : undefined;
  const ledgerRefs = new Set(input.ledgerSourceRefs ?? []);
  const utilizedRefs = new Set(input.utilizedSourceRefs ?? []);
  const rejectedRefs = new Set(input.rejectedSourceRefs ?? []);
  const sources: EvidenceRecoverySourceResult[] = [];
  for (const gold of input.goldSources) {
    let captured = false;
    try { await input.sourceStore.get(gold.sourceRef); captured = encounteredRefs ? encounteredRefs.has(gold.sourceRef) : true; }
    catch { captured = false; }
    let recoveryPath: EvidenceRecoverySourceResult["recoveryPath"] = "NONE";
    if (captured && memoRefs.has(gold.sourceRef)) recoveryPath = "MEMO";
    else if (captured && ledgerRefs.has(gold.sourceRef)) recoveryPath = "LEDGER";
    else if (captured && gold.recoveryQueries.length > 0 && (await input.sourceStore.index({ queries: gold.recoveryQueries, sourceRefs: [gold.sourceRef], limit: 1 })).some(({ sourceRef }) => sourceRef === gold.sourceRef)) recoveryPath = "INDEX";
    sources.push({
      sourceRef: gold.sourceRef,
      captured,
      recoverable: recoveryPath !== "NONE",
      correctlyUtilized: recoveryPath !== "NONE" && (utilizedRefs.has(gold.sourceRef) || rejectedRefs.has(gold.sourceRef)),
      recoveryPath,
    });
  }
  const captured = sources.filter(({ captured: value }) => value);
  const recoverable = captured.filter(({ recoverable: value }) => value);
  return {
    schemaVersion: 1,
    availableGoldSources: sources.length,
    capturedGoldSources: captured.length,
    recoverableCapturedGoldSources: recoverable.length,
    correctlyUtilizedRecoverableGoldSources: recoverable.filter(({ correctlyUtilized }) => correctlyUtilized).length,
    sources,
  };
}

export async function writeEvidenceRecoveryReport(root: string, report: EvidenceRecoveryReport): Promise<void> {
  await atomicWrite(join(root, ".work", "evidence-recovery.json"), `${JSON.stringify(report, null, 2)}\n`);
}
