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

type BudgetOptions = {
  initial?: BudgetSnapshot;
  onChange?: (snapshot: BudgetSnapshot) => void | Promise<void>;
};

function assertIncrement(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("Budget increment must be a finite non-negative number.");
}

export class MemoryRunBudget {
  private modelUsd: number;
  private providerUsd: number;
  private externalNetworkCalls: number;
  private readonly routeCounts = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly ceilings: BudgetCeilings, private readonly options: BudgetOptions = {}) {
    const initial = options.initial ?? { modelUsd: 0, providerUsd: 0, externalNetworkCalls: 0, routeCounts: {} };
    assertIncrement(initial.modelUsd);
    assertIncrement(initial.providerUsd);
    assertIncrement(initial.externalNetworkCalls);
    if (initial.modelUsd > ceilings.modelUsd || initial.providerUsd > ceilings.providerUsd || initial.externalNetworkCalls > ceilings.externalNetworkCalls) {
      throw new Error("Restored budget snapshot exceeds the configured ceilings.");
    }
    for (const [route, count] of Object.entries(initial.routeCounts)) {
      if (!route || !Number.isInteger(count) || count < 0) throw new Error("Restored route counts must be non-negative integers.");
      this.routeCounts.set(route, count);
    }
    if ([...this.routeCounts.values()].reduce((total, count) => total + count, 0) !== initial.externalNetworkCalls) {
      throw new Error("Restored route counts do not equal the external network call total.");
    }
    if ((this.routeCounts.get("github.clone") ?? 0) > ceilings.repositoryClones || (this.routeCounts.get("social.profile") ?? 0) > ceilings.socialProfiles) {
      throw new Error("Restored route counts exceed a route-specific ceiling.");
    }
    this.modelUsd = initial.modelUsd;
    this.providerUsd = initial.providerUsd;
    this.externalNetworkCalls = initial.externalNetworkCalls;
  }

  reserveModel(costUsd: number): Promise<void> {
    assertIncrement(costUsd);
    return this.mutate(() => {
      if (this.modelUsd + costUsd > this.ceilings.modelUsd) throw new Error("Model budget exhausted.");
      this.modelUsd += costUsd;
    });
  }

  recordProvider(costUsd: number): Promise<void> {
    assertIncrement(costUsd);
    return this.mutate(() => {
      if (this.providerUsd + costUsd > this.ceilings.providerUsd) throw new Error("Provider budget exhausted.");
      this.providerUsd += costUsd;
    });
  }

  recordNetworkCall(route: string): Promise<void> {
    return this.mutate(() => {
      if (this.externalNetworkCalls + 1 > this.ceilings.externalNetworkCalls) throw new Error("External network call budget exhausted.");
      const current = this.routeCounts.get(route) ?? 0;
      if (route === "github.clone" && current + 1 > this.ceilings.repositoryClones) throw new Error("Repository clone budget exhausted.");
      if (route === "social.profile" && current + 1 > this.ceilings.socialProfiles) throw new Error("Social profile budget exhausted.");
      this.externalNetworkCalls += 1;
      this.routeCounts.set(route, current + 1);
    });
  }

  private mutate(change: () => void): Promise<void> {
    const operation = this.pending.then(async () => {
      const previous = this.snapshot();
      try {
        change();
        await this.options.onChange?.(this.snapshot());
      } catch (error) {
        this.modelUsd = previous.modelUsd;
        this.providerUsd = previous.providerUsd;
        this.externalNetworkCalls = previous.externalNetworkCalls;
        this.routeCounts.clear();
        for (const [route, count] of Object.entries(previous.routeCounts)) this.routeCounts.set(route, count);
        throw error;
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.pending;
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
