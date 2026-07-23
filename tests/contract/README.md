# Contract Tests

Cross-language checks are currently executed by the two component-native test commands:

- `apps/zotero-addon/scripts/check-contracts.mjs` compares TypeScript wire interfaces
  with `packages/contracts/http/v1.schema.json`;
- `services/paper-runtime/tests/test_shared_contract.py` compares Pydantic models with
  the same schema and validates the shared examples.

Keeping the runners beside their language toolchains avoids adding a fake root package.
This directory will own cross-process fixtures that need their own runner once artifact
envelopes and legacy `zominer.references/1` fixtures land.

All examples use synthetic paper and Zotero identifiers. Do not commit real library data.
