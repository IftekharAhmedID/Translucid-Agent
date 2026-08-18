# ADR-001: Single-investigator publication with durable v3 state

## Status

Accepted for the codex/single-investigator-publication experiment branch.

## Context

The previous publication path serialized a large v2 claim ledger, froze it,
then invoked fresh report-writer sessions to reconstruct findings and summary
semantics. That boundary could lose evidence reasoning, create duplicate
semantic authorities, and prevented research from resolving a material gap
discovered during writing.

The runtime already provides the valuable host guarantees we need: immutable
source capture, atomic state writes, source eligibility checks, provider
draining, snapshot hashing, PDF verification, provenance, and result-last
publication ordering.

## Decision

New runs use one DeepSeek V4 Pro lead session. The lead owns research and
synthesis through native investigation tools. ResearchState v3 stores durable
targets, one finding per target, assertion-level evidence comments, summary
coverage metadata, and host-maintained source/route inventory.

investigation.commit is a two-stage host transaction:

1. prevalidate while active;
2. enter COMMITTING and deny new providers and semantic mutations;
3. drain in-flight providers and pending state writes;
4. refresh source and route inventory;
5. revalidate stable state and atomically persist COMMITTED, or reopen ACTIVE
   with the exact validation defect.

After commit, the host snapshots the state and immutable sources and uses a
deterministic materializer. Source titles and URLs come only from
FileSourceStore. Finding evidence text preserves investigator comments and
adds deterministic S references. ReportStore remains host-only validation and
the result schema v4 adds DISCOVERED-anchor rendering while v2/v3 results
remain readable.

The model registry is the canonical source for model defaults and protocol
routing. DeepSeek V4 Pro is the default Chat Completions route; Luna is an
explicit Responses rollback. Unknown models fail closed.

## Alternatives considered

### Keep the separate report writer

Rejected because it creates a second semantic authority and necessarily
reconstructs claim meaning after research has frozen.

### Fabricate v2 claims for v3 targets

Rejected because duplicate semantic representations recreate the compatibility
seam this design removes. Report mappings use knownResearchPredicateIds to
resolve v2 claim IDs or v3 target IDs directly.

### Silently migrate v1/v2 ledgers

Rejected because historical runs must remain inspectable and reproducible.
Legacy state is read-only; the branch is the experiment boundary.

### Require every HIGH target to appear verbatim in summary prose

Rejected because it bloats executive summaries. Summary targetIds provide
deterministic metadata coverage while prose remains concise.

## Consequences

- Semantic provenance is auditable: one lead agent, zero non-lead semantic
  requests, and zero report-writer requests.
- Synthesis can perform bounded follow-up research and revise a finding.
- Publication is simpler and deterministic after commit.
- v3 requires new lifecycle/tool tests and a fresh externally watched Diego
  qualification before the legacy path can be removed.
- The legacy writer/finalization code remains reachable only from legacy tests
  and compatibility paths until qualification is complete.
