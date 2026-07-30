# Documentation Map

Two kinds of document live here, and they are read differently.

- **Current state** — describes what the code does today. If it disagrees with the code,
  the document is wrong and should be fixed.
- **Design and handoff** — the reasoning, decisions, and constraints behind a feature,
  written before or during its construction. Kept for the constraints, not as a task
  list.

| Document | Kind | Read it when |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current state | A change affects ownership, layering, or dependency direction |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | Current state | You need to know where code belongs |
| [LEGACY_SUPPORT.md](LEGACY_SUPPORT.md) | Current state | You are about to remove or bypass a compatibility reader |
| [ROADMAP.md](ROADMAP.md) | Plan | Looking for unfinished work; nothing here is implemented |
| [UNICONNECTION.md](UNICONNECTION.md) | Design and handoff | Working on the derived reverse-reference index |
| [UNICONNECTION_GRAPH.md](UNICONNECTION_GRAPH.md) | Design and handoff | Working on the graph views or their force layout |
| [UNIZERO_HOME.md](UNIZERO_HOME.md) | Design and handoff | Working on Project View, the editable Board, or the unified Paper catalog |
| [SYNC_AND_LITERATURE_SOURCES.md](SYNC_AND_LITERATURE_SOURCES.md) | Design and handoff | Working on portable state sync, WebDAV, or optional literature data sources |

Component behaviour and commands are documented next to the code:
[apps/zotero-addon/README.md](../apps/zotero-addon/README.md),
[services/paper-runtime/README.md](../services/paper-runtime/README.md),
[packages/contracts/README.md](../packages/contracts/README.md). Repository rules and
verification commands are in [AGENTS.md](../AGENTS.md).

## Keeping these honest

- A current-state document that describes something the code no longer does is a defect and should be updated.
- Design documents record decisions and traps that are still true. When their plan lands,
  update the status line at the top instead of leaving the reader to guess whether the
  work is done.
- Landed roadmap items are removed from the roadmap, not annotated as complete.
