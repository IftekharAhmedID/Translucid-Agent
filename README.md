# Translucid Investigation Agent

Translucid is a development system for evidence-bounded professional-claim investigations. The active headless path accepts a PDF plus arbitrary text or JSON, runs a pinned OpenCode investigator in local Docker or E2B, preserves research and immutable sources in a file-backed run, and renders a deterministic evidence report. The legacy dashboard path still uses PostgreSQL during migration. Neither path scores, ranks, recommends, or infers protected traits.

## What is implemented

### Headless exhaustive report path

The current headless path is the acceptance path for exhaustive evidence reports. `npm run investigate` preserves parsed input, every immutable provider response, specialist memos, memo citation sidecars, and a versioned research checkpoint. Finalization is recovery-only: `npm run finalize -- --run <absolute-run-directory> [--keep-debug]` validates that checkpoint, builds a fresh V5 claim ledger under `.work/finalization/v5`, retrieves bounded candidates from frozen source bytes, judges one claim at a time through marked plain-text JSON, derives the canonical result in TypeScript, and runs a fresh independent audit. It verifies and publishes `report.pdf` before the success-marker `result.json`; a successful result is never overwritten. V3/V4 artifacts are not imported or modified.

The result is schema `1.1`. Every substantive factual résumé assertion—including LOW-materiality facts—must be a claim. Each claim lists its facets, conclusion, status, strength, every supporting or contradicting evidence item, exact quotation, immutable source location, authority, hash, and clickable public URL where available. Unresolved claim and facet strengths render as `—`; the identity-resolution status is labeled as identity metadata and is never a candidate-level verdict.

For a reproducible local fixture:

```bash
npm run investigate -- --submission /absolute/path/resume.txt --classification synthetic --provider-mode fixture --output /absolute/path/runs --keep-debug
npm run finalize -- --run /absolute/path/runs/<run-id> --keep-debug
```

The legacy dashboard and database runner remain in this checkout only until the frozen, live-profile, PDF, and E2B parity gates are accepted; they are not used by finalization-only recovery.

- Next.js 16.3 dashboard, intake, persistent case detail, PDF.js input viewer, findings, observation-backed timeline, entity graph, research frontier, evidence artifacts, and sanitized live agent trace.
- Exactly thirteen PostgreSQL tables covering investigations, leased runs, claims, entities, identifiers, links, immutable artifacts, observations, evidence, research questions, findings, agent events, and provider calls.
- A four-worker runner using `FOR UPDATE SKIP LOCKED`, 15-second heartbeats, 60-second lease recovery, per-provider semaphores, cancellation, deadlines, partial timeout preservation, and runtime cleanup in `finally`.
- One hardened investigator image shared by local Docker and E2B, with a hashed runtime manifest that must match before a run proceeds.
- Native OpenCode primary/subagent sessions, a bounded professional subagent in the fixture flow, a frozen evidence critic, and a fresh top-level adjudicator. Only operational events and public case notes are persisted; model reasoning is neither stored nor exposed.
- Case-scoped gateway tokens whose plaintext exists only in runner memory and the active runtime. Provider/model master credentials remain on the host gateway.
- Fixture and live adapters for Exa/web capture, LinkdAPI with guarded Bright Data fallback, GitHub, archives, SEC/IETF/USPTO records, OpenAlex/Crossref, npm/PyPI/Hugging Face, OSV/GHSA/NVD, and conditional social profiles. PDL is policy-disabled live.
- Deterministic PDF reports generated from saved database state.

## Safety invariants

This development build accepts `SYNTHETIC` and the explicitly scoped `PUBLIC_PROFESSIONAL` classification; all other classifications are rejected. Names alone never resolve identity; an entity link needs two independent, evidence-backed anchors. Search snippets cannot become evidence. Missing evidence remains `UNRESOLVED`, and all adjudicator evidence and claim IDs are checked against saved state. Candidate scores, rankings, hiring recommendations, fraud probabilities, protected-trait analysis, and absence-as-deception language are rejected.

All credentials previously pasted into a chat must be treated as compromised and rotated before live testing. Never copy those values into this repository.

## Local fixture setup

Requirements: Node 22, Docker Desktop, and npm.

```bash
npm ci
cp .env.example .env
docker compose up -d db
```

Set this local value in `.env`:

```env
DATABASE_URL=postgres://translucid:translucid@127.0.0.1:54329/translucid
```

Keep `DATA_CLASSIFICATION=SYNTHETIC`, `PROVIDER_MODE=fixture`, and `RUNTIME_DEFAULT=LOCAL`, then run:

```bash
npm run db:migrate
npm run dev
```

In a second terminal:

```bash
npm run runner
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Fixture mode needs no provider or model credentials; PostgreSQL and Docker are sufficient.

### Attach to a live local OpenCode session

The runner writes a short-lived, mode-`0600` credential file under the gitignored `.debug/attach` directory and removes it during cleanup. While a local run is active, copy its run ID from the case UI and execute:

```bash
npm run attach -- <run-id>
```

The helper passes the random password directly to `opencode attach` without logging or storing it in PostgreSQL.

## Live providers and E2B

Switching `PROVIDER_MODE=live` activates only adapters whose exact credentials and dataset IDs are configured. `/api/capabilities` reports `READY`, `DEGRADED`, `DISABLED_MISSING_CONFIG`, or `DISABLED_POLICY` without revealing secrets. Bright Data dataset IDs are never guessed; unavailable providers degrade only their capability.

E2B also requires `E2B_API_KEY`, `E2B_TEMPLATE_ID`, and an HTTPS `E2B_GATEWAY_PUBLIC_URL` exposing only the runner gateway. Build the E2B template directly from this repository's `Dockerfile` with `npm run e2b:build-template -- translucid-investigator`, then copy the returned template ID into `.env`. A run is rejected unless its generated manifest equals the pinned local manifest. The sandbox allows outbound traffic only to the gateway host.

PDL has no environment contract in this development build. Its capability remains visibly `DISABLED_POLICY`, and the application never depends on it.

The focused finalizer compatibility gate starts and removes its own isolated local Docker/OpenCode runtime; it does not need or reuse an investigation run:

```bash
npm run smoke:finalizer -- --models all
```

It runs the exact 20-case V5.1 qualification set: six atomic claim batches, ten bundle-evidence judgments, and four independent audits. Qualification requires 20/20 valid after at most one repair, at least 19 first-pass responses, no transport failures, and no gold-fixture semantic defects.

## Verification

```bash
npm test
DATABASE_URL=postgres://translucid:translucid@127.0.0.1:54329/translucid npm run test:integration
npm run typecheck
npm run lint
DATABASE_URL=postgres://translucid:translucid@127.0.0.1:54329/translucid npm run build
npm audit --audit-level=high
docker build -t translucid-investigator:1.18.18 .
```

The synthetic acceptance path should also verify native child sessions, an independent auditor model, frozen source hashes, deterministic V5 semantic output across restarts, temporary-PDF verification, result-last publication, and zero remaining case containers after cleanup.

## Primary implementation references

- [OpenCode server](https://opencode.ai/docs/server/), [CLI attach](https://opencode.ai/docs/cli/), [agents](https://opencode.ai/docs/agents/), and [skills](https://opencode.ai/docs/skills/)
- [E2B Dockerfile templates](https://e2b.dev/docs/template/base-image)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/)
- [Exa Search](https://exa.ai/docs/reference/search) and [Contents](https://exa.ai/docs/reference/get-contents)
- [GitHub GraphQL authentication](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [IETF Datatracker API](https://datatracker.ietf.org/api/), and [USPTO ODP](https://data.uspto.gov/apis/bulk-data/search)
- [OpenAlex](https://developers.openalex.org/api-reference/introduction), [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), [OSV API](https://google.github.io/osv.dev/api/), and [NVD API](https://nvd.nist.gov/developers/vulnerabilities)
- [People Data Labs acceptable-use policy](https://privacy.peopledatalabs.com/policies?name=acceptable-data-use-policy)
