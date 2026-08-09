import { requestCancellation } from "../../../../../db/investigations.ts";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try { return Response.json(await requestCancellation((await context.params).id), { status: 202 }); }
  catch (error) { return Response.json({ error: { code: "NOT_FOUND", message: error instanceof Error ? error.message : "Investigation not found." } }, { status: 404 }); }
}
