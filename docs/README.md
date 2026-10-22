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
| [ROADMAP.md](ROADMAP.md) | Plan | You are looking for unfinished work |
| [LEGACY_HOME.md](LEGACY_HOME.md) | Maintenance (legacy surface) | Only if a task explicitly touches Home / Board / Project View |
| [UNICONNECTION.md](UNICONNECTION.md) | Design and handoff | A task touches the derived reverse-reference index or the Graph tab |

Component behaviour and commands are documented next to the code:

- [apps/obsidian-plugin/README.md](../apps/obsidian-plugin/README.md) — **default entry for note-side work**;
- [apps/zotero-addon/README.md](../apps/zotero-addon/README.md) — library backend and bridge host;
- [apps/mcp-server/README.md](../apps/mcp-server/README.md) — agent access to papers over the bridge;
- [services/paper-runtime/README.md](../services/paper-runtime/README.md);
- [packages/contracts/README.md](../packages/contracts/README.md).

Repository rules, current focus, and verification commands are in
[AGENTS.md](../AGENTS.md).

## Keeping these honest

- A current-state document that describes something the code no longer does is a defect and should be updated.
- Design documents record decisions and traps that are still true. When their plan lands,
  update the status table at the top instead of leaving the reader to guess whether the
  work is done. When a surface they describe is retired or legacy, say so there too — a
  design document that still reads as a build plan for something no longer shipped is as
  much a defect as a wrong current-state document.
- Landed roadmap items are removed from the roadmap, not annotated as complete.
