import { SubmissionError } from "./submissions.ts";

export async function sendEmail(to: string, subject: string, text: string, idempotencyKey: string, fetchImpl = fetch): Promise<string> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) throw new SubmissionError("Email delivery is not configured.", 503);
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  const body = await response.json() as { id?: string };
  if (!response.ok || !body.id) throw new SubmissionError("Email could not be delivered. Please try again later.", 503);
  return body.id;
}
