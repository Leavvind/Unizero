"""ASGI entry point for ``uvicorn unizero_runtime.asgi:app``.

Importing this module builds a runtime against the default home. That import side
effect is intentional here and nowhere else -- it is what an ASGI server asks for when
it imports an application by name. Everything else should call
:func:`unizero_runtime.composition.build_runtime` directly.
"""

from __future__ import annotations

from .composition import build_runtime


runtime = build_runtime()
app = runtime.app
