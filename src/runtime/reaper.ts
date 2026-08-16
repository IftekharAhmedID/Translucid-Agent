export function orphanedLocalRuntimeNames(names: string[], activeRunIds: Set<string>): string[] {
  return names.filter((name) => {
    if (!name.startsWith("translucid-case-")) return false;
    return !activeRunIds.has(name.slice("translucid-case-".length));
  });
}
