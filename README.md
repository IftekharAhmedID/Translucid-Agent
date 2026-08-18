# Translucid Investigator

Translucid runs one isolated OpenCode investigator per résumé investigation. A single DeepSeek V4 Pro xhigh session owns research, gap closure, target state, synthesis, and commit while the host durably captures every provider result in immutable, file-backed sources. After commit, the host snapshots and deterministically materializes the report; no post-freeze semantic model runs.

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

## Investigation tools

The lead uses:

- `investigation.plan.set({ identityAnchors, targets })`
- `investigation.target.add({ target })`
- `investigation.synthesis.begin()`
- `investigation.finding.upsert({ targetId, conclusion, status, rationale, remainingGap, evidence })`
- `investigation.progress.get()`
- `investigation.summary.set({ text, targetIds })`
- `investigation.commit()`

Targets are durable semantic predicates. `PDF_TEXT` targets retain exact résumé anchors; `DISCOVERED` targets carry a materiality basis and render under additional independently established findings. Findings preserve assertion-level evidence comments and canonical statuses (`ESTABLISHED`, `PARTIAL`, `UNRESOLVED`, `CONFLICTING`, `CONTRADICTED`). The host maps them deterministically to `2`, `1`, `0`, `-1`, and `-2`, resolves source titles/URLs from the captured manifest, and binds publication to a verified research snapshot SHA-256.

## Research and publication boundary

Provider calls are captured before their results are returned to DeepSeek. Use `source.inventory({ cursor, limit })` to recover every captured reference, including non-citable `SEARCH_DISCOVERY` leads, and `source.excerpts` for exact local text without a network refetch. The lead writes v3 state one finding at a time and may research again during synthesis. `investigation.commit` prevalidates, drains in-flight providers, refreshes host inventory, revalidates, and atomically commits. After commit, providers and semantic mutations are denied; the host writes the snapshot, PDF, provenance, and `result.json` last.

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
