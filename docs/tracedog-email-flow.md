# TraceDog email investigations

Visitors choose PDF or Text in the hero's right-side card, enter their work
email and submit. The server validates a work domain with MX
records, validates the input, and queues an E2B investigation immediately.
There is no email verification code or verification endpoint. Only the final
report or failure notice is emailed. No public case pages, progress sections, PDF
reports, or report attachments are created for this web workflow.

The existing lead prompt, tools, immutable sources, synthesis, and commit
boundary remain. A web-only text publication mode converts the committed
findings to plain text. PDF requests retain configured PDF model/reasoning;
short text requests ask for medium reasoning. The web intake accepts paid providers only. Provider support must be measured;
a requested reasoning level is not proof that a stealth model honors it.

PDF intake uses the existing PDF.js parser in `runtime/extract-input.ts`
before E2B starts. `input/document.json` is now schema version 2: numbered
page lines, recognized resume section ranges, unique URLs, and embedded link
annotations mapped to line ranges where PDF coordinates allow it. The old
`pages[].lines[].line/text`, page text, links and clean-text companion remain
compatible with the existing agent and evidence anchors. No model creates
or rewrites resume facts during parsing. Geometric gaps separate PDF text
fragments; unsupported geometry falls back to explicit line endings. Local
PDF.js fonts/CMaps are configured and parser resources are released.

The optional TraceDog score is an evidence-support index, not a probability of
truth or a judgment about a person. Only submitted claims count (not discovered
facts). Established = 100, partial = 50, unresolved/conflicting/contradicted =
0. Equal claim weights, with status counts and unresolved coverage alongside.
No submitted findings means no score. Failed runs never get a score or a
success report. Human review remains necessary.

Abuse controls: 5 MB / 20-page text-bearing PDFs, 10,000-character text, work
domain screening,
two submissions per email/day, domain and global daily quotas, bounded queue,
one active investigation, runtime/model/provider ceilings, same-origin APIs,
no public results, and seven-day case retention. Intake is serialized before
body buffering. PDFs stay in VALIDATING until file checks pass, then queue.
Storage admission
requires 256 MB free and under 700 MB retained; a two-second monitor cancels
cases above 64 MB or approaching capacity, and failed run artifacts are removed.
Persist job state on a Render
disk. A process restart marks interrupted validation/research and legacy
code-based pending submissions failed rather than silently
duplicating paid research. Email delivery uses Resend idempotency keys.

Resend keys stay server-side. The existing verified translucid.cloud sender
can send with display name TraceDog. reports@tracedog.co requires new sender
DNS verification. The web service disables ZEN free models.

Acceptance: validate rejected files and emails, immediate queueing and rate limits,
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

The work-domain filter does not prove employment or inbox ownership. Global,
domain and mailbox quotas limit resources even if an attacker owns a domain.
Per-connection-IP quotas may be conservative behind shared Render edges.

## Current qualification evidence

- Structured-input qualification: the user's actual resume retained all 54
  numbered lines and 12 unique URLs, with seven section ranges covering every
  line exactly once. Thirteen of fourteen link annotations mapped to lines;
  the remaining URL is retained without a guessed anchor. A fresh E2B sandbox
  verified the mounted JSON exactly matches the host output, the agent file
  is unchanged, and the pinned runtime manifest matches. No model calls were
  made for this input check. Template build:
  `43737892-ea45-4870-8c40-4ae48af1c6ca`. All 202 tests and type checking pass.
- Active Go qualification: the real biography completed with
  `deepseek-v4.1-flash` on E2B and its 72/100 plain-text report reached the
  authorized Rice Inbox. Source/snapshot integrity, model identity and
  single-lead publication passed. Rice rewrote URLs through URL Defense;
  received report text matches after accounting for that wrapping. The first
  PDF report also reached Inbox but included a scored validator placeholder.
  Host target validation now rejects literal placeholders. Subsequent PDF
  retries did not commit and issued no scores; clean post-fix PDF completion
  was unqualified at that checkpoint; the October 13 repair acceptance below
  records the subsequent successful local PDF cycle. All 199 tests and type checking pass. See
  [current Go evidence](tracedog-model-access.md#deepseek-v41-flash-via-the-active-go-subscription).
- At the user's request, inbox-code verification was removed from the UI,
  API and persisted job model. Validated submissions queue immediately;
  legacy pending-code jobs are retired without launching research. Work-domain
  filtering, intake admission, quotas, and resource limits remain.
  Browser tests submit real PDF/text inputs without a code step and prove a
  third submission to the same email is rejected with HTTP 429.
- Real-input testing exposed concurrent v3 mutation loss: writes were ordered,
  but parallel calls constructed updates from stale state. Complete mutations
  and public commit prevalidation are now serialized. Regression tests prove
  all parallel findings persist, revisions are unique, queued prevalidation
  sees them, concurrent plans cannot overwrite one another, and rejected
  validation does not poison later work. 198 tests and type checking passed.
- Failed run diagnostics retain at most 4,000 bytes in private case storage;
  they are never sent in report emails. Successful sends retain their Resend
  message ID. Report subjects distinguish PDF and text investigations.
- The authorized real resume and biography were submitted through the full
  browser/API/worker flow without codes. They reached actual E2B/OpenCode
  research, but did not commit final reports. Test Cloudflare callbacks were
  unstable; a later ngrok trace captured OpenRouter HTTP 402 in-flight credit
  rejection. A read of the account credits endpoint showed $15 total credits
  versus $15.141 total usage. No real-input success report or score was issued.
  Model HTTP error status and numeric Retry-After are now preserved through
  both gateway hops instead of becoming generic HTTP 400.
- Resend confirmed failure-notice delivery to the submitted work mailbox.
  Gmail inspection found those notices in Spam, with plain-text bodies and no
  scores. Successful real-input report delivery and inbox placement remain
  unqualified until the funded-provider test can finish. No mailbox labels
  were changed to make acceptance appear successful. Private diagnostics and
  intake evidence are under ignored `.debug/tracedog-person-live/`.
- New funded-provider qualification: actual E2B OpenCode 1.18.18 completed
  live text and PDF investigations with `deepseek/deepseek-v4.1-flash` through
  OpenRouter, preserving the restricted investigator. Both caught the false
  technical claim, committed result-v4, and passed source/snapshot integrity.
  The actual plain-text report was delivered to Resend's test sink. 194 tests
  and type checking passed. See [run evidence and model settings](tracedog-model-access.md#deepseek-v41-flash-via-openrouter--live-success).
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

## Local intake

The form asks for a work email and submits directly. The shared
`landing/public/email-domains.json` list blocks personal and disposable email
domains in the browser and API; the API also requires working MX records.
Local HTTP origins accept localhost and 127.0.0.1 at the configured port.
`TRACEDOG_GATEWAY_ORIGIN` can point to a public callback tunnel while
`TRACEDOG_ORIGIN` remains the local browser origin. Production origins stay exact.

The landing page and form contain no authorization disclaimer or consent
checkbox. The API accepts the same direct submission payload without a consent
field; work-email screening and the honeypot remain enforced.

The frontend is a React/TypeScript/Tailwind package under `landing`.
Build it before starting the web service (`npm --prefix landing run build`);
the service serves `landing/dist`. Docker and the static Render blueprint
perform that build. The UI component is in `landing/components/ui` and uses
the supplied dog image, with no statistics or client-logo strip.

## PDF recovery timeout fix

The October 13 local PDF submission `kOzmwukSa89-NVpZwDTKc6eopm_H7807`
passed intake and started the E2B lead, then failed with
`UND_ERR_HEADERS_TIMEOUT` during the blocking synthesis-recovery prompt.
Recovery now uses OpenCode's acknowledged `promptAsync` endpoint, then the
existing session-status polling and research deadline/liveness checks. The
host still requires a durable COMMITTED investigation before snapshot binding
and deterministic report materialization. Prompts, model settings, tools and
validation rules are unchanged. A local fake OpenCode server reproduces the
blocking-request timeout and proves the asynchronous recovery waits for commit.

The first retry passed the timeout point but stopped after writing 15/25
findings: the gateway returned `Model budget exhausted`. Its $5 guard had
accumulated every worst-case byte/token reservation without reconciling
successful completions. The provider's completed stream reported 239,299
input tokens and 1,409 output tokens for one request whose reservation used
933,349 request bytes plus 32,000 possible output tokens.

Model calls still reserve their conservative maximum before forwarding.
Successful completed JSON/SSE responses now settle that reservation against
validated provider token totals at the same peak rates, without cache discounts.
Missing/malformed usage, truncated streams and failed calls keep the maximum
reservation. Concurrent reservations remain serialized under the existing
ceiling. No prompt, model, tool, evidence or scoring rule changes are required.
All 207 tests and type checking passed, including split SSE chunks, malformed
usage, retained failure reservations and concurrent ceiling enforcement.

Live repair acceptance: the exact supplied PDF completed run
`e2f7fcf2-8871-4f38-bf3e-8150d7ec4be7` on E2B with the existing Go
`deepseek-v4.1-flash` route. It committed 28 findings (26 submitted claims and
2 discoveries) with one lead and 30 model requests. Source hashes and the
research snapshot independently verified. The 32,199-character plain-text
report was sent through the existing web worker; Resend's email readback
confirmed `last_event=delivered` and subject
`Your TraceDog PDF investigation report`. No E2B sandbox remained after the
run. The local $5 model ceiling was unchanged, and no free model was used.
The private report and run artifacts remain under ignored
`.debug/tracedog-local-intake/`. This qualifies the repaired local PDF cycle;
production deployment is separate.
