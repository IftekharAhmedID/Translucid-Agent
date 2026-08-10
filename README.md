# Translucid Investigation Agent

Translucid is a synthetic-data development system for evidence-bounded candidate-claim investigations. It accepts a PDF plus arbitrary text or JSON, runs a pinned OpenCode investigator in local Docker or E2B, persists every durable state transition in PostgreSQL, and renders a deterministic evidence report. It does not score, rank, recommend, or infer protected traits.

## What is implemented

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

While an active local live-provider run is attached, the focused finalizer compatibility gate can be executed without printing its short-lived credentials:

```bash
npm run smoke:finalizer -- <active-run-id>
```

It requires three consecutive critic, five-claim finding, and summary structured-output cycles before a real résumé acceptance run proceeds.

## Verification

```bash
npm test
DATABASE_URL=postgres://translucid:translucid@127.0.0.1:54329/translucid npm run test:integration
npm run typecheck
npm run lint
DATABASE_URL=postgres://translucid:translucid@127.0.0.1:54329/translucid npm run build
npm audit --audit-level=high
docker build -t translucid-investigator:1.18.15 .
```

The synthetic acceptance path should also verify four simultaneous local runtimes, native child-session trace events, a separate adjudicator session, saved artifacts/findings, deterministic PDF output, and zero remaining case containers after cleanup.

## Primary implementation references

- [OpenCode server](https://opencode.ai/docs/server/), [CLI attach](https://opencode.ai/docs/cli/), [agents](https://opencode.ai/docs/agents/), and [skills](https://opencode.ai/docs/skills/)
- [E2B Dockerfile templates](https://e2b.dev/docs/template/base-image)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/)
- [Exa Search](https://exa.ai/docs/reference/search) and [Contents](https://exa.ai/docs/reference/get-contents)
- [GitHub GraphQL authentication](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [IETF Datatracker API](https://datatracker.ietf.org/api/), and [USPTO ODP](https://data.uspto.gov/apis/bulk-data/search)
- [OpenAlex](https://developers.openalex.org/api-reference/introduction), [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), [OSV API](https://google.github.io/osv.dev/api/), and [NVD API](https://nvd.nist.gov/developers/vulnerabilities)
- [People Data Labs acceptable-use policy](https://privacy.peopledatalabs.com/policies?name=acceptable-data-use-policy)
