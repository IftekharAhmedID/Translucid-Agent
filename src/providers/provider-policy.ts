const routeTimeouts: Array<[prefix: string, milliseconds: number]> = [
  ["brightdata.", 60_000],
  ["linkdapi.", 30_000],
  ["github.clone", 90_000],
  ["exa.", 20_000],
  ["github.", 20_000],
  ["wayback.", 20_000],
  ["common-crawl.", 20_000],
  ["public-records.", 20_000],
  ["scholarly.", 20_000],
  ["packages.", 20_000],
  ["security.", 20_000],
  ["public-fetch", 20_000],
  ["fixture.", 20_000],
];

export function providerTimeoutMs(route: string): number {
  return routeTimeouts.find(([prefix]) => route.startsWith(prefix))?.[1] ?? 20_000;
}

export function providerDeadlineMs(route: string, caseDeadlineAt: number, now = Date.now()): number {
  return Math.max(1, Math.min(providerTimeoutMs(route), caseDeadlineAt - now));
}
