# Paper Runtime

This directory will contain UniZero's local Python paper-processing service.

It owns jobs, configuration, conversion templates, MinerU extraction, Markdown
transforms, artifact generation, annotation mutation, and filesystem publishing.

The runtime remains behind a versioned localhost HTTP API. It does not access Zotero
directly and is not required for metadata or literature-relations features.

No runtime code has been migrated yet. `ZoMiner/paper_service` is the migration source.

See:

- [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- [`../../docs/MIGRATION.md`](../../docs/MIGRATION.md)

