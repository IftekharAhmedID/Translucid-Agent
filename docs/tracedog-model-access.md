# Verified OpenCode model access — 2026-10-13

This check read the actual saved OpenCode provider credentials without printing
or committing them. The repository key matches the saved `opencode-go` key;
the saved `opencode` Console key is different. Listing a model in `/models`
does not prove that the account can generate with it.

| Provider and models tested | Observed result |
| --- | --- |
| Go: DeepSeek V4 Pro, V4 Flash, GLM 5.3 Flash, GPT 5.6 Luna, LongCat 2.5 Preview Free, Step 5 Preview Free | 403: active Go subscription required |
| Console paid: DeepSeek V4 Pro, V4 Flash, GLM 5.3 Flash, GPT 5.6 Luna | 402: insufficient account funds |
| Console free: Cat Jam Free, Big Pickle in actual OpenCode 1.18.18 built-in plan sessions on E2B | Exit 0, response OK, reported cost 0 |
| Console free: Cat Jam with the same built-in plan and `permission.bash=deny` | 403 FreeTierError |
| Saved OpenRouter connection | 401 User not found; no working connection established |

The free-model success was a connectivity test, not a complete investigation.
The distinction corrects the earlier broad statement that the free models were
unavailable even in OpenCode: those earlier probes disabled tools. The updated
probe uses the saved Console credentials and normal built-in plan permissions.
The isolated probe contained only synthetic content and was destroyed afterward.

## Full TraceDog live attempt

The existing restricted investigator was launched on E2B with Cat Jam Free,
medium reasoning, live provider mode, the saved Console key, and text-only
publication. Input: a synthetic brief with three public Node.js claims,
including a deliberately questionable claim about a bundled TypeScript
compiler. The original investigator prompt and tools were preserved.

- Run: `1296a1d1-cbb4-4567-8502-7e26ba42b4b0`
- E2B template: `kq5p2zmrmtp4xfo9312m`
- OpenCode lead session: `ses_ecbf52113ffe6LYfcmgB3rBBFU`
- Model requests reached the gateway; medium reasoning was observed.
- The lead did not commit investigation state. The host failed closed with
  `RESEARCH_STATE_NOT_READY` and created `failure.json`.
- No success `result.json`, report, trust score, or report email was created.
- The test sandbox and temporary gateway tunnel were cleaned up.

The controlled agent denies shell tools. The separate same-client reproduction
shows that this restriction triggers the free-tier rejection. The upstream
[issue report](https://github.com/anomalyco/opencode/issues/50627) describes the
same tool-dependent rejection. No shell permissions or client identities were
changed in TraceDog to work around the provider gate.

## Remaining dependency

A successful full live investigation with the current tool restrictions needs
active Go access, a funded Console account, or another valid funded provider
connection. Do not enable public submissions based on the free-model OK probes.
The prior PDF/text E2B fixture successes remain fixture qualification only.

Private artifacts are under `.debug/tracedog-cat-jam-live/`; the sanitized
catalog/probe data is in `.debug/tracedog-model-access.json`. Both are ignored
by Git. No new paid service, subscription, or balance top-up was created.
