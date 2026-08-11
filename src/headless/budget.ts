export type BudgetCeilings = {
  modelUsd: number;
  providerUsd: number;
  externalNetworkCalls: number;
  repositoryClones: number;
  socialProfiles: number;
};

export type BudgetSnapshot = {
  modelUsd: number;
  providerUsd: number;
  externalNetworkCalls: number;
  routeCounts: Record<string, number>;
};

function assertIncrement(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("Budget increment must be a finite non-negative number.");
}

export class MemoryRunBudget {
  private modelUsd = 0;
  private providerUsd = 0;
  private externalNetworkCalls = 0;
  private readonly routeCounts = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly ceilings: BudgetCeilings) {}

  reserveModel(costUsd: number): void {
    assertIncrement(costUsd);
    if (this.modelUsd + costUsd > this.ceilings.modelUsd) throw new Error("Model budget exhausted.");
    this.modelUsd += costUsd;
  }

  recordProvider(costUsd: number): void {
    assertIncrement(costUsd);
    if (this.providerUsd + costUsd > this.ceilings.providerUsd) throw new Error("Provider budget exhausted.");
    this.providerUsd += costUsd;
  }

  recordNetworkCall(route: string): Promise<void> {
    const operation = this.pending.then(() => {
      if (this.externalNetworkCalls + 1 > this.ceilings.externalNetworkCalls) throw new Error("External network call budget exhausted.");
      const current = this.routeCounts.get(route) ?? 0;
      if (route === "github.clone" && current + 1 > this.ceilings.repositoryClones) throw new Error("Repository clone budget exhausted.");
      if (route === "social.profile" && current + 1 > this.ceilings.socialProfiles) throw new Error("Social profile budget exhausted.");
      this.externalNetworkCalls += 1;
      this.routeCounts.set(route, current + 1);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  snapshot(): BudgetSnapshot {
    return {
      modelUsd: this.modelUsd,
      providerUsd: this.providerUsd,
      externalNetworkCalls: this.externalNetworkCalls,
      routeCounts: Object.fromEntries([...this.routeCounts].sort(([left], [right]) => left.localeCompare(right))),
    };
  }
}
