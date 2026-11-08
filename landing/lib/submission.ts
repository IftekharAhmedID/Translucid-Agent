import blockedDomains from "../public/email-domains.json";

export type InputKind = "pdf" | "text" | "linkedin" | "social" | "person";
export type SubmissionInput = {
  kind: InputKind;
  pdf: File | null;
  text: string;
  textFile?: File | null;
  profile?: string;
  socialId?: string;
  person?: { name: string; context: string; claim?: string };
  email: string;
  website: string;
};

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function profileUrl(raw: string, host: RegExp, path = /^\/\S+/): string | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (raw.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port || !host.test(url.hostname) || !path.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function researchBrief(input: SubmissionInput): string {
  let subject: string;
  if (input.kind === "linkedin") {
    const profile = profileUrl(input.profile?.trim() ?? "", /^(?:[a-z0-9-]+\.)*linkedin\.com$/i, /^\/in\/[^/]+\/?$/);
    if (!profile) throw new Error("Enter a LinkedIn profile URL.");
    subject = `LinkedIn profile: ${profile}`;
  } else if (input.kind === "social") {
    const id = input.socialId?.trim() ?? "";
    const profile = profileUrl(id, /^(?:[a-z0-9-]+\.)*(?:instagram\.com|x\.com|twitter\.com|facebook\.com|tiktok\.com|github\.com|reddit\.com|youtube\.com|bsky\.app|threads\.net|threads\.com)$/i);
    const handle = /^(?:instagram|x|twitter|facebook|tiktok|github|reddit|youtube|bluesky|threads)\s+@[\p{L}\p{N}_.-]+$/iu.test(id);
    if (id.length > 300 || (!profile && !handle)) throw new Error("Enter a social profile URL or platform and @handle.");
    subject = `Social ID: ${profile ?? id}`;
  } else {
    const name = input.person?.name.trim() ?? "";
    const context = input.person?.context.trim() ?? "";
    const claim = input.person?.claim?.trim() ?? "";
    if (!name) throw new Error("Enter the person’s name.");
    if (!context) throw new Error("Enter a workplace or school.");
    if (name.length > 150 || context.length > 200) throw new Error("Keep the name and workplace or school shorter.");
    subject = `Name: ${name}\nWorkplace or school: ${context}${claim ? `\nClaim: ${claim}` : ""}`;
  }
  return `Investigate the public professional information below. Resolve the identity before checking claims against original sources. Report findings with citations and any remaining gaps.\n\n${subject}`;
}

export async function buildSubmission(input: SubmissionInput): Promise<Record<string, string>> {
  const payload: Record<string, string> = { kind: input.kind === "pdf" ? "pdf" : "text", website: input.website };
  if (input.kind !== "pdf") {
    if (input.kind === "text" && input.textFile && input.textFile.size > 40_000) throw new Error("Choose a text file under 40 KB.");
    const text = input.kind === "text" ? (input.textFile ? await input.textFile.text() : input.text) : researchBrief(input);
    const words = countWords(text);
    if (words < 15) throw new Error("Minimum 15 words required.");
    if (words > 1500) throw new Error("Maximum 1,500 words allowed.");
    payload.text = text.trim();
  } else {
    if (!input.pdf || !input.pdf.name.toLowerCase().endsWith(".pdf") || input.pdf.size > 2 * 1024 * 1024) throw new Error("Choose a PDF no larger than 2 MB.");
    const bytes = new Uint8Array(await input.pdf.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF.");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    payload.pdf = btoa(binary);
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid work email.");
  const domain = email.split("@")[1];
  if (blockedDomains.includes(domain) || /(?:^|\.)(?:gmail|yahoo|hotmail|outlook|mailinator|guerrillamail)\./.test(domain)) throw new Error("Use your work email.");
  payload.email = email;
  return payload;
}
