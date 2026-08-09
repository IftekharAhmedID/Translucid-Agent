import { dataClassificationSchema, runtimeKindSchema } from "../../../core/contracts.ts";
import { createInvestigation } from "../../../db/investigations.ts";
import { listInvestigations } from "../../../db/read-model.ts";

export const runtime = "nodejs";

function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data")) return apiError(415, "MULTIPART_REQUIRED", "Use multipart/form-data.");
    const form = await request.formData();
    const submission = form.get("submission");
    if (typeof submission !== "string") return apiError(400, "SUBMISSION_REQUIRED", "A text or JSON submission is required.");
    const runtimeKind = runtimeKindSchema.parse(form.get("runtime"));
    const dataClassification = dataClassificationSchema.parse(form.get("dataClassification"));
    const file = form.get("pdf");
    const resume = file instanceof File && file.size > 0 ? { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name.slice(0, 255) || "resume.pdf" } : undefined;
    const result = await createInvestigation({ submission, runtimeKind, dataClassification, resume });
    return Response.json(result, { status: 202, headers: { location: `/investigations/${result.investigationId}` } });
  } catch (error) {
    return apiError(400, "INVALID_INTAKE", error instanceof Error ? error.message : "Invalid intake.");
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  return Response.json(await listInvestigations(cursor));
}
