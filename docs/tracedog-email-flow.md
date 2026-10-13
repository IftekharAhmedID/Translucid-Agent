# TraceDog email investigations

Visitors choose Upload PDF or Upload Text on the hero's right side. Deploy
TraceDog reveals a work-email step. The server validates a work domain with MX
records and emails a short-lived verification code. Only inbox verification
queues an E2B investigation. No public case pages, progress sections, PDF
reports, or report attachments are created for this web workflow.

The existing lead prompt, tools, immutable sources, synthesis, and commit
boundary remain. A web-only text publication mode converts the committed
findings to plain text. PDF requests retain configured PDF model/reasoning;
short text requests ask for medium reasoning. Free model fallback is selected
before a run, never halfway through a case. Provider support must be measured;
a requested reasoning level is not proof that a stealth model honors it.

The optional TraceDog score is an evidence-support index, not a probability of
truth or a judgment about a person. Only submitted claims count (not discovered
facts). Established = 100, partial = 50, unresolved/conflicting/contradicted =
0. Equal claim weights, with status counts and unresolved coverage alongside.
No submitted findings means no score. Failed runs never get a score or a
success report. Human review remains necessary.

Abuse controls: 5 MB / 20-page text-bearing PDFs, 10,000-character text, work
domain screening, verified inbox, five code attempts, 15-minute code expiry,
two submissions per email/day, domain and global daily quotas, bounded queue,
one active investigation, runtime/model/provider ceilings, same-origin APIs,
no public results, and seven-day case retention. Intake is serialized before
body buffering; verification requests have a 1 KB cap. Storage admission
requires 256 MB free and under 700 MB retained; a two-second monitor cancels
cases above 64 MB or approaching capacity, and failed run artifacts are removed.
Persist job state on a Render
disk. A process restart marks interrupted work failed rather than silently
duplicating paid research. Email delivery uses Resend idempotency keys.

Resend keys stay server-side. The existing verified translucid.cloud sender
can send with display name TraceDog. reports@tracedog.co requires new sender
DNS verification. Big Pickle and Cat Jam require a visible acknowledgement
that their free-period inputs may be used for model improvement.

Acceptance: validate rejected files and emails, verification and rate limits,
restart recovery, plain-text scoring, Resend delivery/retry, E2B isolation and
cleanup, actual OpenCode tool use and committed result, PDF/text live runs,
responsive browser flow, then Render and public HTTPS. Keep submission disabled
until dependencies and durable storage are qualified.

## Hosting

`Dockerfile.web` serves the landing files and same-origin APIs together.
`render.web.yaml` prepares one Docker web service with a 1 GB persistent disk;
this is paid hosting, not the existing static site. It has not been provisioned.
Do not move the apex domain from the static service until the app passes live
PDF/text and delivery checks. Keep `TRACEDOG_ACCEPT_SUBMISSIONS=false` while
model access is unavailable. The standalone static site cannot run these APIs.

For short text the requested reasoning is medium. PDFs preserve the branch's
actual configured medium default; explicit PDF xhigh maps to max on DeepSeek
and Cat Jam. Big Pickle exposes no effort control in the provider's model
catalog, so it uses provider-default reasoning rather than pretending to honor
medium. Registered fallback models do not change the research prompt or tools.

The work-domain filter and inbox verification do not prove employment. Global,
domain and mailbox quotas limit resources even if an attacker owns a domain.
Per-connection-IP quotas may be conservative behind shared Render edges.

## Current qualification evidence

- 191 tests and TypeScript checking passed under Node 22.
- Actual E2B OpenCode 1.18.18 completed full deterministic-fixture text and PDF cases,
  including source capture, single-agent commit, snapshot, plain report, and
  cleanup. No PDF reports were created. This does not qualify model quality.
  PDF extraction emitted a PDF.js standard-font-data warning; the synthetic
  input text and anchored findings still validated.
- Resend accepted a plain-text synthetic report to its test inbox; a later API
  read confirmed `last_event=delivered`. No real applicant data was emailed.
- The live Go investigation reached the actual model route and returned 403:
  an active Go subscription is required. Genuine OpenCode CLI probes of Big
  Pickle and Cat Jam returned `FreeTierError` with tools denied under both
  1.18.15 and 1.19.0. Later native OpenCode probes established that both work
  with the built-in toolset but Cat Jam is rejected when shell is denied.
  The full restricted Cat Jam live investigation still failed before commit.
  See [current model-access evidence](tracedog-model-access.md).
- A fresh E2B template was built under alias `tracedog-investigator-email`,
  separately from the old investigator template. Rebuild whenever the pinned
  runtime manifest changes.
- The isolated headless browser checked upload mode switching, work-email
  reveal, and no overflow at 320/768/1024/1440px. A mocked UI-only code
  verification/queued sequence passed. The real disabled backend returned the
  expected 503; it was surfaced in the form. No page script exceptions occurred.
- Independent review found and corrected upload admission order, verification
  binding to proxy IP, missing v4 evidence explanations, and storage exhaustion
  handling. Paid-model reservations now conservatively include tool schemas,
  request bytes, and published peak prices rather than the old generic rate.

Sources: [OpenCode model catalog and privacy](https://opencode.ai/v2/docs/console/models/),
[Go client/session requirements](https://opencode.ai/v2/docs/console/go/),
[Resend sending API](https://resend.com/docs/api-reference/emails/send-email).
