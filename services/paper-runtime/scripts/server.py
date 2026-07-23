"""Launcher script for the add-on's process manager.

``python -m unizero_runtime`` is the real entry point. This file exists because the
add-on spawns the runtime as ``<python> <script>`` and locates the interpreter from the
script's path -- see ``findPythonUnix`` in ``apps/zotero-addon/src/runtime-client/
process.ts``, which strips two path components and looks for ``.venv`` there.

Living at ``services/paper-runtime/scripts/server.py`` therefore makes that heuristic
resolve ``services/paper-runtime/.venv``, which is where the runtime's virtualenv
actually is. Moving this file up or down a directory silently breaks interpreter
auto-detection, so it stays put.

Point the add-on's "server.py path" setting at this file.
"""

from __future__ import annotations

import sys
from pathlib import Path


# Support running from a checkout without installing the package first: the add-on may
# well be pointed at a fresh clone whose venv has not been created yet, and failing with
# ModuleNotFoundError would be a much worse diagnostic than simply working.
_SRC = Path(__file__).resolve().parent.parent / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from unizero_runtime.__main__ import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
