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

## Dependency after the free-model attempts

At this stage a successful full live investigation with the current tool restrictions needed
active Go access, a funded Console account, or another valid funded provider
connection. Do not enable public submissions based on the free-model OK probes.
The prior PDF/text E2B fixture successes remain fixture qualification only.

Private artifacts are under `.debug/tracedog-cat-jam-live/`; the sanitized
catalog/probe data is in `.debug/tracedog-model-access.json`. Both are ignored
by Git. No new paid service, subscription, or balance top-up was created.

## Muse Spark 1.3 Contributor Free — regular Console test

The user requested this exact model and explicitly excluded Go. Official
[OpenCode documentation](https://opencode.ai/v2/docs/console/models/) lists
`muse-spark-1.3-contributor-free` as free for a limited time at
`https://opencode.ai/inference/v1/responses`. This differs from the Go model
`muse-spark-1.3-contributor`. Contributor prompts/completions may be used for
future Meta model training; only synthetic content was used here.

Added the exact free model to the runtime registry/config with Responses,
medium/xhigh reasoning, and zero model-cost reservation. The route explicitly
rejects Go. Existing defaults, lead instructions, tools and restrictions remain.
The fresh E2B build was `1abfa9c1-2afe-422e-9d29-c716c801c9aa`.

Observed probes using actual OpenCode 1.18.18 on E2B and the saved Console key:

- Built-in plan with normal permissions: exit 0, response OK, reported cost 0.
- Built-in plan with only `permission.bash=deny` added: 403 `FreeTierError`.
  Both probes used the regular `/inference/v1/responses` endpoint.

Full restricted investigator attempt:

- Run: `a3f67a89-5f60-4562-bfa1-b1422c057de0`
- Lead: `ses_ecbdda8afffetIiX8qrou5oZZe`
- Input: the same synthetic Node.js claims used for Cat Jam.
- Provider: regular Console (`ZEN` in the existing code), never Go.
- Actual Responses model calls were made; medium reasoning was observed.
- The lead failed to commit, including after synthesis recovery. Host failure:
  `RESEARCH_STATE_NOT_READY`. No report, score or success marker was issued.
- Private artifact: `.debug/tracedog-muse-live/<run-id>/failure.json`.
- Probe and investigation sandboxes and temporary tunnel were cleaned up.

191 tests and type checking passed. Focused model/route checks passed again
after adding the free-price assertion. This is a tested failed live attempt,
not successful research qualification and not permission to enable submissions.

## DeepSeek V4.1 Flash via OpenRouter — live success

The user supplied a new OpenRouter credential and requested the exact
`deepseek/deepseek-v4.1-flash` model. The old saved connection's 401 above is
historical: the new key returned HTTP 200 from the key endpoint and an actual
synthetic chat completion. No Go or Console endpoint was used for these runs.
The key is in ignored local configuration with mode 0600; it is never sent to
the browser or E2B sandbox. E2B still uses the authenticated host gateway.

Added the model to the explicit registry and pinned runtime. The new template
build is `705ef68c-c759-434c-b752-af75f7f6ea28`. The original lead prompt,
custom tools, denied shell, network isolation, source capture, commit boundary,
runtime limits, and $5 model / $10 provider ceilings were retained.

| Live synthetic input | Text | PDF |
| --- | --- | --- |
| Run | `d65c6a58-ecb5-4ba6-83be-81ad465dfb18` | `2be3f595-2472-4170-bb60-a732f7be89e6` |
| Lead session | `ses_eca54aa8affe4lFMv1xfF97BEJ` | `ses_eca501b7bffenSIiemYBY60xjm` |
| Time through research freeze | 160.659 seconds | 187.450 seconds |
| Model requests | 16 | 20 |
| Provider tools | One search batch, eight fetches | One search batch, twelve fetches |
| Result | Committed result-v4 and plain report | Committed result-v4 and plain report |
| Reviewed submitted claims | Four, including project identity | Three explicit technical claims |
| Evidence-support score | 75/100 | 67/100 |

Both runs established the runtime/V8 and 2024 first-release claims and correctly
contradicted the claim that every standard Node.js installation bundles the
TypeScript compiler. Immutable-source integrity and bound research snapshot
verification passed. Exactly one semantic lead ran; there were no report-writer
model calls, PDF report artifacts, or failure markers. The score difference
reflects different claim selection, not different conclusions on the three
technical claims; this illustrates the documented limitation of the score.

Both requested medium reasoning. The current model catalog advertises max,
high, and low, so observed medium on the gateway proves the request setting,
not the provider's exact internal effort. See the official
[model page](https://openrouter.ai/deepseek/deepseek-v4.1-flash) and
[reasoning parameter documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

The actual text report was sent as plain text to Resend's delivery test sink;
a subsequent email API read confirmed `last_event=delivered`. No real person or
customer inbox was used. Both sandboxes and the temporary gateway tunnel were
removed afterward. Private results and acceptance evidence are under ignored
`.debug/tracedog-openrouter-live/` and `.debug/tracedog-openrouter-pdf-live/`.

Independent review found and fixed OpenRouter fallback/plugin escapes, effort
normalization, and output-limit accounting. Only the approved model and local
function tools can pass; routing overrides and paid server plugins are denied.
194 tests and TypeScript checking passed on Node 22. PDF extraction retained
the previously documented standard-font-data warning; extracted text, anchors,
and all acceptance assertions passed.

To run this route, set `RESEARCH_OPENCODE_PROVIDER=OPENROUTER`,
`RESEARCH_MODEL=deepseek/deepseek-v4.1-flash`, `OPENROUTER_API_KEY`, and the E2B
configuration. For the web worker, select
`TRACEDOG_MODEL=deepseek/deepseek-v4.1-flash`; readiness then requires the
OpenRouter key and the worker selects its route. This qualification did not
deploy the web service or enable public submissions. Durable Render hosting,
public callback routing, and sender-domain verification remain launch work.

## DeepSeek V4.1 Flash via the active Go subscription

The user renewed Go and explicitly selected it for the real-input tests.
The existing saved Go key matches the repository key; the authenticated Go
catalog includes `deepseek-v4.1-flash`. Actual E2B OpenCode 1.18.18 requests
returned HTTP 200 through `https://opencode.ai/zen/go/v1/chat/completions`.
No OpenRouter or Console route was used for these tests.

Select `TRACEDOG_MODEL=deepseek-v4.1-flash`,
`RESEARCH_MODEL=deepseek-v4.1-flash`, `RESEARCH_OPENCODE_PROVIDER=GO`,
and the saved `OPENCODE_API_KEY`. The Render web blueprint and environment
example now use that route, while public submissions remain disabled.
The template build is `6aafb9dc-e648-4cff-935a-84aa3bd99999` on the separate
`tracedog-investigator-email` alias. The original research prompts, tools,
shell denial, source capture, host commit, ceilings, and text-only publication
remain. Peak-price reservation is $0.30/M input and $1.20/M output, following
the [Go model pricing](https://opencode.ai/v2/docs/console/go/).
Medium reasoning is requested; the model catalog exposes low/high/max, so
the registry records high as its effective setting.

The real biography run `3b318719-e8e2-456c-a1cf-8e30314ee1c3` committed 13
findings from 238 captured sources with 30 model requests and 52 provider
calls. Nine submitted claims contribute to the evidence-support score:
four established and five partial, yielding 72/100. Four discovered facts
are excluded. Result-v4, source integrity, snapshot binding, the text artifact,
and the single lead's actual model metadata passed validation. The plain-text
report was delivered to the authorized Rice mailbox and found in Inbox.

The first real PDF run `b62d900a-410c-41bc-8f93-d1de1cc2c50e` also committed
and reached Inbox, but incorrectly included a literal validator `probe` as a
claim, yielding a preliminary 34/100. Do not treat that preliminary PDF report
as clean qualification. Host validation now rejects literal probe, placeholder,
TODO and TBD predicates in both plan creation and target addition, without
changing the prompt or hiding persisted findings. A regression test failed
before the fix; all 199 tests and type checking pass afterward.

The next PDF retries `ec3f27b9-7516-46b7-8d65-83a0e933732b` and
`a63703db-9da9-4870-be04-0f04a79d21a8` stopped before committing and
failed closed without reports or scores. Native-session diagnostics from the
latter show recoverable tool errors (a search preview over the 40 KiB bound
and a scholarly adapter error), but do not establish the termination cause.
At that checkpoint, the clean post-fix PDF outcome was unqualified. The
October 13 local repair run `e2f7fcf2-8871-4f38-bf3e-8150d7ec4be7` subsequently
committed 28 findings from the exact supplied PDF and its plain-text report
was confirmed delivered by Resend. Recovery uses an asynchronous prompt and
completed model reservations settle against provider token usage under the
unchanged $5 guard; see [repair acceptance](tracedog-email-flow.md#pdf-recovery-timeout-fix). Real-input artifacts and mailbox checks stay under ignored
`.debug/tracedog-person-live/`; they are never committed.
