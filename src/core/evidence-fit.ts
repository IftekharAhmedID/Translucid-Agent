const ignored = new Set([
  "about", "after", "been", "between", "from", "have", "into", "more", "over", "that", "their", "there", "these", "this", "through", "with",
]);

function tokens(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[a-z][a-z0-9+.#-]{3,}/g)?.filter((token) => !ignored.has(token)) ?? [];
}

export function evidenceQuoteHasClaimAnchor(exactQuote: string, normalizedClaim: string): boolean {
  const quoteTokens = new Set(tokens(exactQuote));
  return tokens(normalizedClaim).some((token) => quoteTokens.has(token));
}
