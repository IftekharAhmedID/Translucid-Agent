import { getSql } from "../../../../../db/client.ts";
import { listAgentEvents } from "../../../../../db/investigations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const [investigation] = await getSql()<Array<{ id: string }>>`SELECT id FROM investigations WHERE id = ${id}`;
  if (!investigation) return Response.json({ error: { code: "NOT_FOUND", message: "Investigation not found." } }, { status: 404 });
  const fromHeader = Number(request.headers.get("last-event-id") ?? "0");
  let cursor = Number.isSafeInteger(fromHeader) && fromHeader >= 0 ? fromHeader : 0;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const poll = async () => {
        if (polling) return;
        polling = true;
        try {
          const events = await listAgentEvents(id, cursor);
          for (const event of events) {
            cursor = event.id;
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: agent_event\ndata: ${JSON.stringify(event)}\n\n`));
          }
          const [state] = await getSql()<Array<{ status: string }>>`SELECT status FROM investigations WHERE id = ${id}`;
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ status: state?.status ?? "UNKNOWN", cursor })}\n\n`));
          if (state && terminal.has(state.status) && events.length === 0) {
            if (timer) clearInterval(timer);
            controller.close();
          }
        } catch (error) { controller.error(error); if (timer) clearInterval(timer); }
        finally { polling = false; }
      };
      void poll();
      timer = setInterval(() => void poll(), 1_000);
      request.signal.addEventListener("abort", () => { if (timer) clearInterval(timer); try { controller.close(); } catch { /* stream is already closed */ } }, { once: true });
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
