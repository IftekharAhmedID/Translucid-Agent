import { getInvestigationDetail } from "../../../../db/read-model.ts";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const investigation = await getInvestigationDetail(id);
  return investigation ? Response.json(investigation) : Response.json({ error: { code: "NOT_FOUND", message: "Investigation not found." } }, { status: 404 });
}
