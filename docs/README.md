# Documentation Map

Two kinds of document live here, and they are read differently.

- **Current state** — describes what the code does today. If it disagrees with the code,
  the document is wrong and should be fixed.
- **Design and handoff** — the reasoning, decisions, and constraints behind a feature,
  written before or during its construction. Kept for the constraints, not as a task
  list.

**Product direction (this branch):** Obsidian is the active note front end; the Zotero
add-on remains the library backend (metadata, conversion, annotations, References /
Citations cache, bridge). **Unizero Home is legacy** — keep only for maintenance when a
task names that surface. See the root [README](../README.md) and [AGENTS.md](../AGENTS.md).

| Document | Kind | Default open? | Read it when |
| --- | --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current state | Ownership / boundary changes | A change affects ownership, layering, or dependency direction (Obsidian-first diagram) |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | Current state | Finding a path | You need to know where code belongs (Obsidian paths first) |
| [LEGACY_SUPPORT.md](LEGACY_SUPPORT.md) | Current state | Removing compat code | You are about to remove or bypass a compatibility reader |
| [ROADMAP.md](ROADMAP.md) | Plan | Looking for unfinished work | Unfinished work only; nothing here is a work order by itself. Obsidian section first. |
| [LEGACY_HOME.md](LEGACY_HOME.md) | Maintenance · **legacy surface** | **No** | Only if a task explicitly touches Home / Board / Project View |
| [UNICONNECTION.md](UNICONNECTION.md) | Design and handoff | **No** (unless relations/graph) | Derived reverse-reference index; graph render traps when editing the Graph tab |
| [SYNC_AND_LITERATURE_SOURCES.md](SYNC_AND_LITERATURE_SOURCES.md) | Design and handoff | **No** | Portable state sync / WebDAV invariants, or extending sync past Project/Board |

Component behaviour and commands are documented next to the code:

- [apps/obsidian-plugin/README.md](../apps/obsidian-plugin/README.md) — **default entry for note-side work**;
- [apps/zotero-addon/README.md](../apps/zotero-addon/README.md) — library backend and bridge host;
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
