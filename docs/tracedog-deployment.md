# TraceDog deployment

## Public landing page

The React landing page builds from `landing` with
`npm ci --legacy-peer-deps && npm run build` and publishes `landing/dist`.
The existing Render static service follows `main`, uses root directory
`landing`, and must publish `dist` rather than the former `public` directory.
Keep `SKIP_INSTALL_DEPS=true` because the build command installs dependencies.
`landing/render.yaml` records the build and response headers, including the
same-origin scripts and API connections needed by the form.

Render service: `srv-db6rhp3l550s739r1hd0`, in the TraceDog production
environment `evm-db6rcbom7kps73b2gstg`.
Preview: https://tracedog-site.onrender.com/.
Both `tracedog.co` and `www.tracedog.co` are verified in Render; the apex
returns HTTPS 200. The initial successful deployment was
`e804ec28efb278d95e38faa71180e8d1f0f877d9`.

The current frontend supports PDF and text intake, reveals work email after
input, blocks personal email domains, and uses the existing
`/api/submissions` contract. PDFs are limited to 2 MB and two pages; text
requires 15–1,500 words. A static site alone cannot execute this API.

Validation: 209 backend tests, three frontend input tests, TypeScript checking,
and a Node 22 production build pass. Chrome checks cover 320/768/1024/1440px,
exact copy, rotating words, reduced motion, hidden email, input errors, and a
clean console. Local API checks reject oversized and three-page PDFs before
queuing an investigation.

## Investigation backend

`render.web.yaml` prepares a single Docker web service using `Dockerfile.web`,
with a 1 GB persistent disk mounted at `/var/data/tracedog`, one worker, and
`/health`. The Docker image builds the same React frontend and serves it with
the submission API. A public backend needs a Render web service; the existing
static site is not an investigation host.

Keep credentials server-side. Configure the selected model provider, E2B,
search tools and Resend through Render environment variables. Set
`TRACEDOG_ORIGIN` to the page origin and `TRACEDOG_GATEWAY_ORIGIN` to the
backend's publicly reachable origin for authenticated E2B callbacks. Enable
submissions only after verifying storage, callback routing, provider access
and email delivery. The prepared blueprint defaults to submissions disabled.

The local PDF workflow has completed committed investigations and email
delivery. Publication requires a committed research snapshot and materialized
report; parsed input or intermediate findings alone do not qualify a run.

## Rollback

For landing defects, redeploy the previous successful static deployment or
revert the landing commit. DNS can remain pointed to the same static service. Backend deployment and
public investigation qualification are separate from a successful page deploy.
