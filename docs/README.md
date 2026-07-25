# Documentation Map

Three kinds of document live here, and they are read differently.

- **Current state** — describes what the code does today. If it disagrees with the code,
  the document is wrong and should be fixed.
- **Design and handoff** — the reasoning, decisions, and constraints behind a feature,
  written before or during its construction. Kept for the constraints, not as a task
  list.
- **Decision record** — a dated choice and its rejected alternatives, in `decisions/`.
  Superseded rather than edited.

| Document | Kind | Read it when |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current state | A change affects ownership, layering, or dependency direction |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | Current state | You need to know where code belongs |
| [LEGACY_SUPPORT.md](LEGACY_SUPPORT.md) | Current state | You are about to remove or bypass a compatibility reader |
| [ROADMAP.md](ROADMAP.md) | Plan | Looking for unfinished work; nothing here is implemented |
| [UNICONNECTION.md](UNICONNECTION.md) | Design and handoff | Working on the derived reverse-reference index |
| [UNICONNECTION_GRAPH.md](UNICONNECTION_GRAPH.md) | Design and handoff | Working on the graph views or their force layout |
| [decisions/0001-addon-and-runtime-boundary.md](decisions/0001-addon-and-runtime-boundary.md) | Decision record | Questioning the add-on/runtime split |

Component behaviour and commands are documented next to the code:
[apps/zotero-addon/README.md](../apps/zotero-addon/README.md),
[services/paper-runtime/README.md](../services/paper-runtime/README.md),
[packages/contracts/README.md](../packages/contracts/README.md). Repository rules and
verification commands are in [AGENTS.md](../AGENTS.md).

## Language

Current-state documents, decision records, and component READMEs are written in English,
matching the public contracts and code. The two UniConnection documents are written in
Chinese because they were authored as handoff notes; each stays in one language rather
than becoming a mix. New documents follow the English rule unless they are handoff notes
for a specific person.

## Keeping these honest

- A current-state document that describes something the code no longer does is a defect.
  Fix it in the same change that moved the code.
- Design documents record decisions and traps that are still true. When their plan lands,
  update the status line at the top instead of leaving the reader to guess whether the
  work is done.
- Landed roadmap items are removed from the roadmap, not annotated as complete.
