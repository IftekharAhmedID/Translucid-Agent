# Translucid Investigator

Translucid runs one isolated OpenCode investigator per résumé investigation. A single `gpt-5.6-luna` xhigh session owns research, gap closure, claim state, and publication while the host durably captures every provider result in immutable, file-backed sources. After research freezes, that same session publishes one summary and an ordered list of coherent résumé findings through typed native tools.

The host backend owns only structure, durability, source-reference resolution, résumé-anchor validation, and deterministic rendering. It does not decide whether evidence proves a claim, whether a source is authoritative, whether a claim is complete, or which status the investigator should assign.

## Local run with a visible OpenCode TUI

Docker Desktop must be running. The default provider mode is the deterministic fixture; live research requires the provider credentials in `.env`.

```bash
npm install
npm run investigate -- \
  --resume /absolute/path/resume.pdf \
  --classification public-professional \
  --provider-mode live \
  --runtime local \
  --output /absolute/path/runs \
  --watch \
  --keep-debug
```

`--watch` opens the local OpenCode session in a visible terminal. Without it, the run remains headless and can be attached with:

```bash
npm run attach -- <active-run-id>
```

The run directory contains the immutable input, captured sources, durable `.work` state (including `research-state.json` and `research-snapshot.json`), `report.pdf`, and `result.json`. Successful cleanup removes disposable runtime caches but preserves the research corpus for same-session publication or read-only inspection. Unfinished historical cases are re-researched through `npm run investigate`; there is no legacy memo/finalizer recovery path. `result.json` is written last and is the success marker.

For a text or JSON submission:

```bash
npm run investigate -- \
  --submission /absolute/path/submission.txt \
  --classification synthetic \
  --provider-mode fixture \
  --runtime local \
  --output /absolute/path/runs \
  --watch \
  --keep-debug
```

## Report tools

The lead uses:

- `report.summary.set({ summary, researchClaimIds })`
- `report.finding.upsert({ findingId, section, claim, anchor, evidence, notes, status, sourceRefs, researchClaimIds })`
- `report.finding.remove({ findingId })`
- `report.progress.get()`
- `report.finalize()`

Finding IDs are idempotency keys. Every new draft is bound to a verified research snapshot SHA-256, and every summary/finding maps to unique frozen research claim IDs. The anchor stores a PDF page, line range, and exact text and is bound to the immutable input SHA-256. Sources are references such as `S12`; URLs are resolved from the captured manifest. Status values are investigator-authored: `2`, `1`, `0`, `-1`, and `-2`.

## Research and publication boundary

Provider calls are captured before their results are returned to Luna. Use `source.inventory({ cursor, limit })` to recover every captured reference, including non-citable `SEARCH_DISCOVERY` leads, and `source.excerpts` for exact local text without a network refetch. Luna saves explicit publication-ready claim state through `research.state.set`; after freeze, recover it with read-only `research.state.get({ cursor, limit })`. The host validates schema and source-reference existence but does not adjudicate evidence. At the research freeze, external providers are disabled, local recall remains available, and one bounded publication continuation produces the PDF before `result.json`.

## Development checks

```bash
npm run test
npm run typecheck
npm run check
docker build --tag translucid-investigator:local .
```

The E2B template remains available for a later parity gate:

```bash
npm run e2b:build-template -- translucid-investigator
```
