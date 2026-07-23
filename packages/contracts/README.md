# Contracts

This directory owns language-neutral compatibility contracts shared by the TypeScript
add-on and Python paper runtime.

Planned contents:

- versioned HTTP request, response, capability, and error schemas;
- artifact envelopes and artifact-kind schemas;
- synthetic example payloads;
- legacy fixtures such as `zominer.references/1`.

Contracts are public compatibility surfaces. Do not place add-on or runtime
implementation logic here.

