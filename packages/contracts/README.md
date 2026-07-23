# Contracts

Language-neutral contracts shared by the Zotero add-on and paper runtime.

```text
http/v1.schema.json  Canonical HTTP v1 fields, requiredness, and capabilities
examples/            Synthetic payloads used by both language checks
```

Change the schema first, then update the TypeScript and Pydantic mirrors in the same
change.

Verification:

- `apps/zotero-addon`: `npm run check`
- `services/paper-runtime`: `.venv/Scripts/python.exe -m pytest`

Keep implementation logic and real Zotero library data out of this package.
