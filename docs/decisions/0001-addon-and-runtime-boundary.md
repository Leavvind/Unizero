# ADR 0001: One Zotero Add-on with a Separate Paper Runtime

- Status: Accepted
- Date: 2026-07-23

## Context

Zoference is a TypeScript Zotero add-on focused on metadata identifiers, references,
citations, and library relations. ZoMiner consists of a plain-JavaScript Zotero add-on
and a Python service that runs MinerU, transforms Markdown, generates artifacts, and
publishes files.

UniZero needs a coherent product surface while retaining heavyweight local document
processing and allowing future modules.

## Decision

UniZero will ship user-facing capabilities through one TypeScript Zotero add-on.

Heavy PDF processing remains in a separate Python process called the paper runtime.
The add-on communicates with it through a versioned localhost HTTP API.

Zoference provides the initial add-on build and lifecycle foundation. ZoMiner's
Zotero-facing capabilities are ported into that add-on. ZoMiner's Python service is
migrated as the initial paper runtime.

The first releases use a static feature-module registry. Feature modules, scholarly
providers, and paper-runtime pipeline steps remain separate concepts.

## Consequences

Positive:

- users install one XPI rather than two overlapping Zotero plugins;
- References, Citations, and metadata remain usable without starting MinerU;
- Python and GPU dependencies stay outside Zotero's Firefox sandbox;
- the HTTP boundary supports compatibility checks and independent testing;
- future user-facing modules share lifecycle, settings, and artifact infrastructure.

Costs:

- the product still has two runtime environments and two dependency toolchains;
- installation and upgrade of the Python runtime require a deliberate distribution
  strategy;
- cross-language contracts and compatibility fixtures become first-class maintenance
  work;
- ZoMiner's plain-JavaScript UI and adapter code must be ported rather than embedded as
  a second plugin.

## Rejected alternatives

### Put MinerU and all processing inside the Zotero add-on

Rejected because Zotero is not a Node or Python runtime, and MinerU's dependency and
resource requirements are inappropriate for an XPI.

### Move all scholarly network access into the Python service

Rejected because metadata and relations features should remain available without the
heavy local runtime.

### Keep two independent plugins under one brand

Rejected as the target architecture because it retains duplicate lifecycle,
preferences, UI, adapters, and user-facing integration problems. It may be used only
as a temporary migration state.

### Implement dynamic third-party executable modules immediately

Rejected for the initial releases because it adds security, compatibility, and
lifecycle complexity before the internal module boundaries are proven.

