import { createHash } from "node:crypto";

const nonNetworkKeys = new Set([
  "questionId",
  "claimIds",
  "agent",
  "agentId",
  "sessionId",
  "publicRationale",
]);

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return value.trim();
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([entryKey]) => !nonNetworkKeys.has(entryKey))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, item]) => [entryKey, canonical(item, entryKey)]));
  }
  if (typeof value !== "string") return value;
  if (key === "url" || key?.endsWith("Url")) return canonicalUrl(value);
  if (["username", "handle", "platform"].includes(key ?? "")) return value.trim().toLocaleLowerCase("en-US");
  return value.trim();
}

export function canonicalNetworkArguments(value: Record<string, unknown>): Record<string, unknown> {
  return canonical(value) as Record<string, unknown>;
}

export function providerRequestFingerprint(providerRoute: string, arguments_: Record<string, unknown>): string {
  const networkArguments = { ...arguments_ };
  if (providerRoute === "linkdapi.profile") delete networkArguments.requiredMaterialField;
  return createHash("sha256")
    .update(providerRoute)
    .update("\0")
    .update(JSON.stringify(canonicalNetworkArguments(networkArguments)))
    .digest("hex");
}
