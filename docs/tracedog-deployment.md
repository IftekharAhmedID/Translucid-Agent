# TraceDog deployment

## Public landing page

Deploy `landing/public` as a Render static site in the TraceDog project, from
`main`. Root directory: `landing`; build command: `true`; publish directory:
`public`; environment: `SKIP_INSTALL_DEPS=true`. `landing/render.yaml` records
the configuration. The page uses HTML, CSS, and SVG with no build dependencies,
browser JavaScript, provider credentials, or case data. Contact links lead to
the founder's existing personal site. The case shown is explicitly fictional.

Add `tracedog.co` as the apex custom domain in Render; Render also adds `www`
and redirects it to the apex. In Namecheap Advanced DNS, replace conflicting
website records with:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| A | @ | 216.24.57.1 | 1 min or Automatic |
| CNAME | www | The assigned Render site hostname | 1 min or Automatic |

Remove old parking/redirect records and AAAA records for these website hosts.
Preserve MX, mail-related TXT, and unrelated subdomains. After DNS propagates,
verify both domains in Render and test HTTPS, `www` redirection, `/robots.txt`,
and `/sitemap.xml`. Render manages TLS. See
[Render's Namecheap guide](https://render.com/docs/configure-namecheap-dns).

## Investigator service: work needed before public access

The publication branch is a CLI, not a hosted application. Its existing
Dockerfile packages the isolated OpenCode runtime; it is not an HTTP host for
the CLI. Its case gateway listens on loopback and is created per run. Deploying
that Dockerfile as a public web service does not produce an investigation app.

The initial landing launch exposes no investigation endpoint. Keep using the
controlled local CLI described in README until the following work is complete:

1. Add an authenticated submission/status/download API and user interface.
   Validate input size/type and require case ownership for every operation.
   Do not expose the internal case gateway, model proxy, or OpenCode endpoint
   to unauthenticated users.
2. Add durable job ownership, bounded concurrency, budgets, restart recovery,
   and cancellation. Run investigations outside HTTP request lifetimes.
3. Use E2B for isolated runtime execution on Render. Build and pin the E2B
   template, then qualify parity with the local runtime. The README explicitly
   lists the E2B parity gate as later work; current unit tests alone are not
   production acceptance.
4. Route authenticated E2B callbacks to the correct case gateway through a
   stable HTTPS service, with a host that binds to Render's `0.0.0.0:$PORT`.
   `E2B_GATEWAY_PUBLIC_URL` currently needs explicit routing to the per-run
   gateway; setting it to a domain alone is insufficient.
5. Store inputs, immutable sources, snapshots, PDFs, and structured results
   durably with access controls and a retention/deletion policy. Render's
   default ephemeral filesystem is not case storage.
6. Configure selected model/provider keys server-side from `.env.example`.
   Add `E2B_API_KEY`, `E2B_TEMPLATE_ID`, gateway routing, and explicit spending
   limits. Never put these in the landing service or frontend assets.
7. Qualify a synthetic end-to-end case, then an authorized public-professional
   case, including cleanup, callback authentication, interrupted runs,
   budget exhaustion, report downloads, and immutable source provenance.

No paid investigation hosting tier is provisioned by the landing launch.
Choose compute/storage tiers after runtime qualification and capacity testing.

## Rollback

For landing defects, redeploy the previous successful static deployment or
revert the landing commit. Investigation execution remains in the existing
controlled workflow. DNS can remain pointed to the same static service.
