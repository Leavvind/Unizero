"""Thread-safe configuration ownership for the local service."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .. import paths


DEFAULT_CONFIG = {
    "port": 23300,
    "vault_root": "",
    "papers_dir": "20_Papers",
    # Filled in from the runtime home at construction time; see ConfigStore.__init__.
    # It stays a config key because users may point work at a faster or larger disk.
    "work_dir": "",
    "bbt_rpc": "http://127.0.0.1:23119/better-bibtex/json-rpc",
    "options": {
        "backend": "pipeline",
        "ocr_mode": "auto",
        "language": "en",
        "device": "auto",
        "enable_formula": True,
        "enable_table": True,
        "split_threshold": 200,
        "chunk_size": 50,
        "images_mode": "none",
        "table_mode": "none",
        "strip_repeated_lines": False,
        "strip_references": True,
        "table_vlm": False,
    },
    "frontmatter": {
        "tags": ["paper"],
        "extra": {},
    },
}
_DICT_KEYS = ("options", "frontmatter")


def _copy(value: dict) -> dict:
    return json.loads(json.dumps(value))


class ConfigStore:
    def __init__(self, path: Path | None = None, home: Path | None = None):
        self.home = home or paths.runtime_home()
        self.path = path or paths.config_path(self.home)
        self._lock = threading.RLock()
        self._config = self._load()

    def _load(self) -> dict:
        config = _copy(DEFAULT_CONFIG)
        # Resolved per-instance rather than baked into DEFAULT_CONFIG so that two stores
        # with different homes (notably in tests) do not share a work directory.
        config["work_dir"] = str(paths.work_dir(self.home))
        if not self.path.exists():
            return config
        user = json.loads(self.path.read_text(encoding="utf-8"))
        for key, value in user.items():
            if key in _DICT_KEYS and isinstance(value, dict):
                config[key].update(value)
            else:
                config[key] = value
        return config

    def snapshot(self) -> dict:
        with self._lock:
            return _copy(self._config)

    def update(self, update: dict) -> dict:
        with self._lock:
            user = {}
            if self.path.exists():
                user = json.loads(self.path.read_text(encoding="utf-8"))
            for key, value in update.items():
                if key in _DICT_KEYS and isinstance(value, dict):
                    merged = dict(user.get(key) or {})
                    merged.update(value)
                    user[key] = merged
                else:
                    user[key] = value
            self.path.write_text(
                json.dumps(user, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self._config = self._load()
            return _copy(self._config)
