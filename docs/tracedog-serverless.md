# TraceDog serverless intake

The Render static page calls one Supabase Edge Function. The function validates
the request, prepares the input in an E2B coordinator, starts
a detached command, and returns HTTP 202. The coordinator runs the existing
investigation CLI with its existing isolated investigator sandbox. It verifies
the committed snapshot and report hash, emails the plain-text report through
Resend, and destroys itself. No application database or storage bucket is used.

The two sandboxes exist only for a job. The coordinator holds provider/email
credentials; the investigator keeps its existing restricted network and tools.
E2B, model and provider usage remains billable under the existing accounts.
Jobs interrupted by sandbox termination cannot resume in this storage-free path.

## Resources

- Supabase project: `qlhstbyydtjlrdytapgm` (`TraceDog`), `us-east-2`, Free
  organization `cugucxvdlpitxfdmqyue`.
- Function: `start-investigation`, deployed with JWT verification disabled for
  the public form. Exact page-origin checks and server-side input validation apply.
- Coordinator template: `xk7xny1502dkg6ga6tpm` (`tracedog-coordinator`).
- Investigator template: the existing `E2B_TEMPLATE_ID` secret. The coordinator
  receives this as `TRACEDOG_INVESTIGATOR_TEMPLATE_ID` because E2B sets its
  reserved `E2B_TEMPLATE_ID` variable to the coordinator's own image.

## Deployment

Build the coordinator with Node 22. If the runtime, Dockerfile, or package lock
changes, rebuild the existing investigator template first so its pinned runtime
manifest matches the coordinator:

```sh
node --env-file=.env --env-file=.env.local --import tsx scripts/build-e2b-template.ts tracedog-investigator-email
node --env-file=.env --env-file=.env.local --import tsx scripts/build-e2b-template.ts tracedog-coordinator Dockerfile.coordinator
```

Set server-side secrets via `supabase secrets set --env-file ... --project-ref
qlhstbyydtjlrdytapgm`: `E2B_API_KEY`, `E2B_TEMPLATE_ID`,
`TRACEDOG_COORDINATOR_TEMPLATE_ID`, `OPENCODE_API_KEY`, `EXA_API_KEY`,
optional `GITHUB_TOKEN`, `RESEND_API_KEY`, `RESEND_FROM`, and `TRACEDOG_MODEL`.
Enable with `TRACEDOG_ACCEPT_SUBMISSIONS=true` only when configuration and
acceptance checks pass. Never put these keys in
the frontend. `TRACEDOG_RETAIN_FOR_VERIFICATION=true` is only for controlled
acceptance runs; those sandboxes must be killed after inspecting their proof.

Deploy the function:

```sh
supabase functions deploy start-investigation --project-ref qlhstbyydtjlrdytapgm --use-api --no-verify-jwt
```

The static build uses public `VITE_SUBMISSIONS_URL`. Allow the project origin
in CSP `connect-src`. Preserve the other security headers. An empty build value
keeps the local API flow unchanged. Cloudflare is not required.

Before creating a sandbox, admission checks allow fewer than two running jobs
and fewer than ten recent TraceDog email outcomes plus running jobs in 24 hours.
The daily count uses Resend's existing metadata, with a bounded lookup that
fails closed. Existing per-investigation budgets and the 30-minute deadline
remain in effect. These admission checks are best effort: simultaneous requests
can race, and a sandbox killed before sending email leaves no durable outcome.
They are not an atomic billing cap or proof of recipient ownership. CORS and
the hidden form field reject ordinary unwanted browser requests, not determined
API callers. A strict global cap would require durable shared coordination.

Before launch, prove a real PDF and text submission, browser/launcher
disconnection, committed snapshot and report integrity, Resend delivery, and
cleanup. Verify invalid emails, word/byte/page limits, capacity rejection,
CORS, and generic infrastructure errors. No result/download/history API is
provided. A browser error must never be presented as successful submission.

## Live acceptance — October 14, 2026

Render deployed commit `872ee4827956403d9d1e2560400e27bce0b9e679` and the
Supabase health endpoint confirmed submissions enabled. Chrome submitted the
text investigation through `tracedog.co`; the original resume PDF was submitted
to the same public endpoint (197,489 bytes, accepted in 5.94 seconds). The
Chrome extension's file-picker permission prevented automating that upload UI.
Both jobs continued after their launch request ended, produced report emails,
and Resend confirmed `delivered`:

- Text job `1e39573f-b4d2-4111-8e5a-6f88bf88496a`, email
  `01a13dc4-a6c5-7dac-999b-5c72c40d0dbc`, 11,239-byte report.
- PDF job `318096a7-5e8f-41cc-b8e6-167649859545`, email
  `01a13dc7-ec6f-7ab6-906d-cd349f69550b`.

Both coordinators and investigators terminated automatically. An earlier
controlled PDF run also passed explicit COMMITTED-state, snapshot and report
hash verification before its delivery was confirmed. Live checks rejected
personal emails, short/oversized text, invalid PDF input, wrong origins, and
a third concurrent job. The page and www redirect returned HTTPS 200, CSP
allowed the function, and the public bundle contained no provider credentials.
All 216 backend tests, three frontend tests, type checking, and the frontend
production build passed. Both dependency audits reported zero vulnerabilities.
Private report and delivery evidence stays in the ignored `.debug` directory.

Rollback: disable the Edge Function with `TRACEDOG_ACCEPT_SUBMISSIONS=false`
and restore the previous Render deployment. Keep the local workflow available.
