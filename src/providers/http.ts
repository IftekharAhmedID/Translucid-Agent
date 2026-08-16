import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const secretKey = /(authorization|api[-_]?key|token|secret|password|cookie)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redactSecrets(item)]),
    );
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) if (secretKey.test(key)) url.searchParams.set(key, "[REDACTED]");
      return url.toString();
    } catch {
      return value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]");
    }
  }
  return value;
}

function isPrivateIp(address: string): boolean {
  const normalized = address.replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only credential-free public HTTP(S) URLs are allowed.");
  }
  if (url.hostname === "localhost") throw new Error("Private network destinations are not allowed.");
  const literal = isIP(url.hostname.replace(/^\[|\]$/g, ""));
  if (literal && isPrivateIp(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Private network destinations are not allowed.");
  if (!literal) {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      throw new Error("Private or unresolved network destinations are not allowed.");
    }
  }
  return url;
}

export async function safePublicFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicHttpUrl(raw);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === 3) throw new Error("Too many redirects.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect is missing Location.");
    url = await assertPublicHttpUrl(new URL(location, url).toString());
  }
  throw new Error("Fetch failed.");
}
