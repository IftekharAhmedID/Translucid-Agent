---
name: investigation-reporting
description: Reconstruct and audit the committed investigation before deterministic publication.
compatibility: opencode
---

# Investigation reporting

This skill is the synthesis phase of a single-investigator run. The host owns
permissions, source identity, durable state, validation, and publication. You
own only the reasoning that becomes a finding or summary.

## Reconstruct the durable queue

Call investigation.progress.get first. Start from targets, not memory. A
PDF_TEXT target is the exact résumé predicate; a DISCOVERED target is an
independently found material fact with its own materiality basis. Never invent
targets or source references.

Group related targets into small clusters, but persist one finding per
investigation.finding.upsert call. Before writing a finding, inspect captured
sources with source.inventory and source.excerpts. Discovery records are leads,
never evidence.

Split a résumé section into 2–4 material predicates only when authority,
timeframe, or confidence differs. Keep the shared résumé section in the
existing `section` field; do not invent grouping fields. Subject-only
corroboration is UNRESOLVED unless the subject is the authoritative system of
record for that exact fact. Be aggressive in discovery but conservative in
adjudication: search as though material evidence may exist, then state only
what each captured source establishes.

## Recover evidence and test the predicate boundary

For each source ask who originated it, what it directly establishes, what it
only implies, whether it is subject-controlled, whether a stronger authoritative
system of record exists, and whether its date fits the target. Preserve
historical/current and contribution/ownership distinctions.

Every evidence entry has an assertion-level comment. State the material fact
established by the source and, when relevant, the important boundary it does
not establish. For example: “This commit establishes substantive contribution;
it does not establish project leadership.” Do not replace these comments with
new report prose later.

## Research during synthesis

If a conclusion still depends on a resolvable material gap, search now. The
gateway permits provider calls during SYNTHESIZING. Capture the source, inspect
it locally, and revise the affected finding. Do not preserve a weak judgment
merely because the first research pass ended.

Use the strict status contract:

- ESTABLISHED: at least one SUPPORTS entry and remainingGap: null.
- PARTIAL: at least one SUPPORTS entry and a non-empty remaining gap, where the
  captured evidence establishes only a precisely stated subset of the submitted
  predicate.
- UNRESOLVED: a non-empty remaining gap.
- CONFLICTING: at least one SUPPORTS and one CONTRADICTS entry.
- CONTRADICTED: at least one CONTRADICTS entry.

## Reverse audit and commit

Before the summary, audit open HIGH targets, same-name contamination,
subject-controlled evidence, timeframe errors, contribution mistaken for
ownership, unsupported quantities, and overlooked contradictions. Revise
findings when the audit changes the judgment.

Never broaden a supported relation into ownership, exclusivity, causality,
leadership, or precision the source does not establish. Call
investigation.summary.set with concise prose and every HIGH target ID.
The IDs are metadata coverage, not a requirement to repeat every target in the
executive prose. Then call investigation.commit. Treat a 422 as precise host
validation feedback and repair the state; do not weaken wording to bypass it.

Aim for compact writing: summary 180 words, conclusion 70, evidence comment 30,
rationale 60, and remaining gap 30. The host accepts a small safety envelope
and reports the exact overflowing field and count when repair is needed.

After commit succeeds, do not call providers or semantic mutation tools. The
host will snapshot and materialize the report deterministically.
