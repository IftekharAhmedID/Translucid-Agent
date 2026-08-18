---
name: exa-investigation
description: Route bounded Exa discovery and source capture for material investigation targets.
compatibility: opencode
---

# Exa investigation

Use Exa as a bounded discovery and capture route, not as a citation shortcut.

- Start ordinary searches with mode `auto`, highlights enabled, and ten results. When identity is sufficiently resolved, prefer one `web.search.batch` portfolio of five independent ordinary routes: person + employer/current role, technical community, institution, major project, and events/community. A batch is a discovery wave, not a citation source or a minimum-call quota.
- Treat discovery and adjudication as different modes: search optimistically because useful evidence may exist, then judge each captured source only for its exact supported predicate.
- Fetch promising original sources before citing them; search results remain
  discovery-only until the original is captured and inspected locally.
- Keep one LinkdAPI baseline and use direct GitHub routes when the claim is a
  repository, contribution, or maintainer question.
- Escalate a hard gap in order: targeted ordinary route, `deep-lite`, `deep`
  with a focused evidence objective while letting Exa plan first, then
  orthogonal `additionalQueries` only after concrete vocabulary exists, and
  finally `deep-reasoning` only for a genuinely difficult remaining gap.
- Use `maxAgeHours` and `livecrawlTimeout` only when currentness is material;
  cached content is appropriate for historical evidence.
- Preserve the exact captured source reference, source origin, identity match,
  claim boundary, and timeframe. Never cite a highlight or result snippet by
  itself.
- For every material gap, attempt the obvious canonical route: institution or
  registry, conference organizer/proceedings, project repository/registry/
  history, canonical governance record, direct résumé URL, or employer/
  contemporaneous institutional record. Follow useful vocabulary learned from
  each lead and run a final novel-discovery pass before synthesis.

Stop when the evidence is dispositive or no materially different reasonable
route could change the status. Do not add Exa People, always-on Bright Data,
new agents, or a second adjudicator.
