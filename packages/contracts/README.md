# Contracts

This directory owns language-neutral compatibility contracts shared by the TypeScript
add-on and Python paper runtime.

Current contents:

- `http/v1.schema.json`: canonical request/response fields, requiredness, API version,
  and required capabilities;
- `examples/`: synthetic payloads validated by the Python models.

Contracts are public compatibility surfaces. Do not place add-on or runtime
implementation logic here, and do not add placeholder files merely to make the directory
look occupied.

`npm run check` compares the TypeScript interfaces with the canonical schema.
`services/paper-runtime/tests/test_shared_contract.py` compares the Pydantic models and
validates the shared examples. Artifact envelopes and legacy fixtures remain planned.
