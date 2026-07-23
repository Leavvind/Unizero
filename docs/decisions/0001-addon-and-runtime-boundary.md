# ADR 0001: Zotero Add-on and Local Paper Runtime

- Status: Accepted
- Date: 2026-07-23

## Context

UniZero has two different execution needs:

- direct access to Zotero APIs, windows, items, and annotations;
- heavyweight PDF processing with Python, MinerU, and filesystem publishing.

Zotero's privileged Firefox environment is not an appropriate host for the Python
dependency stack, while metadata and relations features should remain available without
starting that stack.

## Decision

UniZero consists of one Zotero add-on and one optional local paper runtime.

The add-on owns all Zotero-facing UI and mutations. The runtime owns PDF extraction,
document transforms, jobs, and filesystem output. They communicate only through a
versioned HTTP API bound to localhost.

User-facing feature modules are statically registered in the add-on. Scholarly providers
and runtime pipeline steps remain separate extension concepts.

## Consequences

- Users have one Zotero add-on and a separately installable runtime.
- Metadata and relations work without MinerU.
- Python and GPU dependencies stay outside Zotero.
- The HTTP contract, capability negotiation, and process lifecycle are maintained as
  product boundaries.
- Each component has its own build and test command.

## Rejected alternatives

### Run document processing inside the add-on

Rejected because Zotero is not a Python host and the processing stack is too large and
resource-intensive for an XPI.

### Move all scholarly access into the runtime

Rejected because it would make lightweight metadata and relations features depend on
the optional service.

### Ship multiple Zotero add-ons

Rejected because lifecycle, preferences, UI, and Zotero mutations need one owner.

### Load third-party executable feature modules

Rejected for now because it adds security and compatibility costs before the internal
boundaries require it.
