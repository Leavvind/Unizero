"""MinerU 4 adapter, executed in a disposable process to release model memory."""

from __future__ import annotations

import argparse
import json
import sys
from importlib.metadata import version
from pathlib import Path


def parsing_tier(backend: str) -> str:
    tier = backend
    if tier not in {"flash", "basic", "standard", "advanced"}:
        raise ValueError(f"Unsupported MinerU parsing tier: {backend}")
    return tier


def command(
    source: Path, output: Path, backend: str = "basic", ocr_mode: str = "auto",
    enable_formula: bool = True, enable_table: bool = True,
) -> list[str]:
    return [
        sys.executable, "-m", "unizero_runtime.providers.mineru",
        str(source), str(output), "--tier", parsing_tier(backend),
        "--ocr-mode", ocr_mode,
        *([] if enable_formula else ["--exclude-formulas"]),
        *([] if enable_table else ["--exclude-tables"]),
    ]


def extract(
    source: Path, output: Path, tier: str, ocr_mode: str,
    enable_formula: bool = True, enable_table: bool = True,
) -> None:
    installed = version("mineru")
    if installed.split(".")[0] != "4":
        raise RuntimeError(f"UniZero requires MinerU 4.x; installed version is {installed}")

    # Import only in the worker: runtime startup and tests need no model stack.
    from mineru.parser import ParseResult, parse
    from mineru.parser.writer import FileBasedDataWriter
    from mineru.render import render_content_list

    result = parse(source, tier=parsing_tier(tier), ocr_mode=ocr_mode, page_range="all")
    excluded = set()
    if not enable_formula:
        excluded.add("equation")
    if not enable_table:
        excluded.add("table")
    if excluded:
        for page in result.middle_json.pages:
            page.blocks = [block for block in page.blocks if block.type not in excluded]

    destination = output / source.stem
    result.save(FileBasedDataWriter(str(destination)))
    # save() materializes images on a copy. Render the saved representation so
    # Markdown, tables, and content-list image paths all reference the same files.
    saved = ParseResult.from_json((destination / "middle_json.json").read_text(encoding="utf-8"))
    content = render_content_list(saved.middle_json)
    (destination / f"{source.stem}_content_list.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--tier", choices=["flash", "basic", "standard", "advanced"], default="basic")
    parser.add_argument("--ocr-mode", choices=["auto", "ocr", "txt"], default="auto")
    parser.add_argument("--exclude-formulas", action="store_true")
    parser.add_argument("--exclude-tables", action="store_true")
    args = parser.parse_args()
    extract(args.source, args.output, args.tier, args.ocr_mode,
            not args.exclude_formulas, not args.exclude_tables)


if __name__ == "__main__":
    main()
