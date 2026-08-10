import { buildCapabilityRegistry } from "../../../core/capabilities.ts";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    authoritative: false,
    source: "APP_CONFIGURATION_PREVIEW",
    registry: buildCapabilityRegistry(process.env),
  }, { headers: { "cache-control": "no-store" } });
}
