# Contracts

This directory owns language-neutral compatibility contracts shared by the TypeScript
add-on and Python paper runtime.

Planned contents:

- versioned HTTP request, response, capability, and error schemas;
- artifact envelopes and artifact-kind schemas;
- synthetic example payloads;
- legacy fixtures such as `zominer.references/1`.

Contracts are public compatibility surfaces. Do not place add-on or runtime
implementation logic here, and do not add placeholder files merely to make the directory
look occupied.

**Nothing lives here yet.** Until it does, `apps/zotero-addon/src/runtime-client/contracts.ts`
and `services/paper-runtime/src/unizero_runtime/contracts.py` are hand-written mirrors of
one contract that both type-check green while disagreeing. See the change rules in
[`../../AGENTS.md`](../../AGENTS.md) and [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md).

