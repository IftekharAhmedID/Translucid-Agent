import { parseByteRange } from "../../../../../../core/http-range.ts";
import { getArtifact } from "../../../../../../db/read-model.ts";

export const runtime = "nodejs";

function safeFileName(value: string | null): string { return (value ?? "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "artifact"; }

export async function GET(request: Request, context: { params: Promise<{ id: string; artifactId: string }> }): Promise<Response> {
  const { id, artifactId } = await context.params;
  const artifact = await getArtifact(id, artifactId);
  if (!artifact) return Response.json({ error: { code: "NOT_FOUND", message: "Artifact not found." } }, { status: 404 });
  const bytes = Buffer.from(artifact.bytes);
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseByteRange(rangeHeader, bytes.byteLength) : undefined;
  if (rangeHeader && !range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.byteLength}` } });
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  const disposition = artifact.mimeType === "application/pdf" || artifact.mimeType.startsWith("text/") || artifact.mimeType.startsWith("image/") ? "inline" : "attachment";
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "content-type": artifact.mimeType,
      "content-length": String(body.byteLength),
      "content-disposition": `${disposition}; filename="${safeFileName(artifact.fileName)}"`,
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}` } : {}),
      "cache-control": "private, no-store",
      "x-artifact-sha256": artifact.sha256,
    },
  });
}
