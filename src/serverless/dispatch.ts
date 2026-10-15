import { decodePdf, SubmissionError, validateText, validateWorkEmailAddress } from "../web/validation.ts";

export type DispatchPayload = { email: string; kind: "text"; text: string } | { email: string; kind: "pdf"; pdf: string };
type Configuration = {
  origin: string;
  enabled: boolean;
  launch: (payload: DispatchPayload, id: string) => Promise<void>;
};

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new SubmissionError("Invalid request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3 * 1024 * 1024) throw new SubmissionError("Upload is too large.", 413);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new SubmissionError("Invalid request."); }
}

export function createDispatcher(config: Configuration): (request: Request) => Promise<Response> {
  return async request => {
    const allowed = request.headers.get("origin") === config.origin;
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" });
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", config.origin);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "content-type");
    }
    const json = (value: unknown, status: number) => new Response(JSON.stringify(value), { status, headers });
    if (request.method === "GET") return json({ status: "ok", submissionsEnabled: config.enabled }, 200);
    try {
      if (!allowed) throw new SubmissionError("Request not allowed.", 403);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) throw new SubmissionError("Request not allowed.", 403);
      if (!config.enabled) throw new SubmissionError("Investigations are temporarily unavailable. Please try again later.", 503);
      const value = await boundedJson(request);
      if (value.website) throw new SubmissionError("Submission could not be accepted.");
      const email = validateWorkEmailAddress(value.email);
      let payload: DispatchPayload;
      if (value.kind === "text") payload = { kind: "text", email, text: validateText(value.text) };
      else if (value.kind === "pdf") { decodePdf(value.pdf); payload = { kind: "pdf", email, pdf: value.pdf as string }; }
      else throw new SubmissionError("Choose PDF or text.");
      const id = crypto.randomUUID();
      await config.launch(payload, id);
      return json({ submissionId: id }, 202);
    } catch (error) {
      if (error instanceof SubmissionError) return json({ error: error.message }, error.status);
      console.error("TraceDog dispatch failed", error instanceof Error ? error.name : "UnknownError");
      return json({ error: "TraceDog could not start that investigation. Please try again shortly." }, 503);
    }
  };
}
