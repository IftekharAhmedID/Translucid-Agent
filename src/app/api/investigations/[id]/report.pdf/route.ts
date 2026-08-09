import { generateInvestigationReport } from "../../../../../report/pdf.ts";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const report = await generateInvestigationReport(id);
  if (!report) return Response.json({ error: { code: "NOT_FOUND", message: "Investigation not found." } }, { status: 404 });
  return new Response(Uint8Array.from(report), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="translucid-${id}.pdf"`, "cache-control": "private, no-store" } });
}
