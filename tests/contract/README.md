# Contract Tests

This directory will verify compatibility between the TypeScript add-on client, the
Python runtime, and versioned example payloads.

Initial coverage should include:

- health and API capability negotiation;
- conversion request and job-result fixtures;
- common artifact envelopes;
- error response mapping;
- legacy `zominer.references/1` parsing;
- rejection of unsupported breaking contract versions.

Use synthetic paper and Zotero identifiers. Do not commit real library data.

**Nothing lives here yet.** Drift between the two hand-written `contracts` modules
currently surfaces only as a 4xx at the moment a user acts; these tests are what would
catch it earlier. See [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md).

