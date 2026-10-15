import { SubmissionError } from "../web/validation.ts";

// Reuse the email provider's existing metadata; no application database is needed.
export async function checkDailyCapacity(envs: Record<string, string>, running: number, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const cutoff = now - 24 * 60 * 60_000;
  let count = running;
  let after = "";
  const timestamp = (value: string) => Date.parse(value.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/\+00$/, "+00:00"));
  for (let page = 0; page < 3; page++) {
    const url = new URL("https://api.resend.com/emails");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${envs.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) break;
    const body = await response.json() as { data?: { id: string; from: string; subject: string; created_at: string }[]; has_more?: boolean };
    if (!Array.isArray(body.data)) break;
    for (const email of body.data) {
      // Resend uses PostgreSQL timestamp strings; normalize them for both Node and Deno.
      const created = timestamp(email.created_at);
      if (!Number.isFinite(created)) throw new Error("Invalid email metadata timestamp.");
      if (created >= cutoff && email.from === envs.RESEND_FROM && /^(Your TraceDog (PDF|text) investigation report|TraceDog investigation could not be completed)$/.test(email.subject)) count++;
    }
    if (count >= 10) throw new SubmissionError("TraceDog has reached its daily capacity. Please try again tomorrow.", 429);
    if (!body.has_more || body.data.some(email => timestamp(email.created_at) < cutoff)) return;
    const last = body.data.at(-1)?.id;
    if (!last || last === after) break;
    after = last;
  }
  throw new SubmissionError("TraceDog's capacity check is temporarily unavailable. Please try again later.", 503);
}
