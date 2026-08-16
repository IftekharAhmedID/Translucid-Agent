---
name: entity-resolution
description: Resolve people, accounts, domains, and records without same-name conflation.
compatibility: opencode
---

Load this method whenever identity affects a finding. Treat every external account or record as separate until at least two independent anchors connect it to the subject, such as employer overlap, verified cross-link, location/history agreement, repository identity, or an authored institutional page. Name, avatar, biography wording, and intuition alone do not resolve identity. Keep conflicting records separate, state ambiguity explicitly, and never borrow evidence across unresolved identities.
