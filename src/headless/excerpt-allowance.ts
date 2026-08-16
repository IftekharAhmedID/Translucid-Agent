import type { SourceExcerptResult } from "./source-store.ts";

export type BudgetedSourceExcerptResult = SourceExcerptResult & {
  returnedCharacters: number;
  remainingCharacters: number | null;
  budgetExhausted: boolean;
};

type Allowance = {
  remaining: number;
  pending: Promise<void>;
};

function returnedCharacters(result: SourceExcerptResult): number {
  return result.excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0);
}

export class SessionExcerptAllowances {
  private readonly sessions = new Map<string, Allowance>();

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  register(sessionId: string, characters: number): void {
    if (!sessionId || !Number.isInteger(characters) || characters < 0) throw new Error("Excerpt allowance requires a session ID and a non-negative integer character limit.");
    if (this.sessions.has(sessionId)) throw new Error(`Excerpt allowance is already registered for session ${sessionId}.`);
    this.sessions.set(sessionId, { remaining: characters, pending: Promise.resolve() });
  }

  execute(
    sessionId: string,
    sourceRef: string,
    requestedCharacters: number,
    load: (maximumCharacters: number) => Promise<SourceExcerptResult>,
  ): Promise<BudgetedSourceExcerptResult> {
    const allowance = this.sessions.get(sessionId);
    if (!allowance) {
      return load(requestedCharacters).then((result) => ({
        ...result,
        returnedCharacters: returnedCharacters(result),
        remainingCharacters: null,
        budgetExhausted: false,
      }));
    }

    let output: BudgetedSourceExcerptResult | undefined;
    const operation = allowance.pending.then(async () => {
      if (allowance.remaining === 0) {
        output = {
          sourceRef,
          excerpts: [],
          returnedCharacters: 0,
          remainingCharacters: 0,
          truncated: true,
          budgetExhausted: true,
        };
        return;
      }
      const maximumCharacters = Math.min(requestedCharacters, allowance.remaining);
      const result = await load(maximumCharacters);
      const returned = returnedCharacters(result);
      if (returned > maximumCharacters) throw new Error("Source excerpt backend exceeded the granted character allowance.");
      allowance.remaining -= returned;
      output = {
        ...result,
        returnedCharacters: returned,
        remainingCharacters: allowance.remaining,
        truncated: result.truncated || maximumCharacters < requestedCharacters,
        budgetExhausted: allowance.remaining === 0,
      };
    });
    allowance.pending = operation.catch(() => undefined);
    return operation.then(() => output!);
  }
}
