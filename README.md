# Translucid Investigator

Translucid runs one isolated OpenCode investigator per résumé investigation. Research happens in the lead session with bounded specialist tasks and immutable, file-backed source captures. After research, the same lead session publishes one summary and an ordered list of coherent résumé findings through five typed native tools.

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

The run directory contains the immutable input, captured sources, specialist memos, durable `.work` state, `report.pdf`, and `result.json`. Successful cleanup removes disposable runtime caches but preserves `.work`, so `npm run finalize -- --run /absolute/path/to/run --watch` can resume publishing without repeating research. `result.json` is written last and is the success marker.

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

- `report.summary.set({ summary })`
- `report.finding.upsert({ findingId, section, claim, anchor, evidence, notes, status, sourceRefs })`
- `report.finding.remove({ findingId })`
- `report.progress.get()`
- `report.finalize()`

Finding IDs are idempotency keys. The anchor stores a PDF page, line range, and exact text and is bound to the immutable input SHA-256. Sources are references such as `S12`; URLs are resolved from the captured manifest. Status values are investigator-authored: `2`, `1`, `0`, `-1`, and `-2`.

## Recovery boundary

The supported crash-recovery boundary is host-persisted specialist memos plus `.work/report-draft.json`. OpenCode’s disposable session database is intentionally not part of the authoritative run. A resumed publishing session is seeded from the résumé, lead context, specialist memos, source manifest, and existing draft. Publishing cannot call providers, search, delegate, or create new network activity.

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
