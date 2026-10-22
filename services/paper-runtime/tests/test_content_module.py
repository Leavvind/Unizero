"""The Content module: what the Markdown keeps of formulas, tables, and References."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from unizero_runtime.pipeline import steps
from unizero_runtime.pipeline.postprocess import PostCtx, pass_formulas, pass_tables
from unizero_runtime.pipeline.steps import (
    MODULE_REGISTRY,
    ConversionContext,
    ConvertOptions,
    PaperMeta,
)
from unizero_runtime.pipeline.workflow import TemplateModule


SIMPLE = "<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>"
COMPLEX = '<table><tr><td colspan="2">a</td></tr><tr><td>1</td><td>2</td></tr></table>'


def _tables_ctx(mode: str) -> PostCtx:
    return PostCtx(
        content_list=[{"type": "table", "page_idx": 0}, {"type": "table", "page_idx": 1}],
        zotero_pdf_uri="zotero://open-pdf/library/items/K",
        table_mode=mode,
    )


def test_html_mode_keeps_simple_tables_as_html() -> None:
    out = pass_tables(f"{SIMPLE}\n\n{COMPLEX}\n", _tables_ctx("html"))

    assert SIMPLE in out
    assert "| a | b |" not in out
    # an unrefined complex table still becomes a pointer in either mode
    assert COMPLEX not in out
    assert "p2" in out


def test_markdown_mode_turns_simple_tables_into_pipe_tables() -> None:
    out = pass_tables(f"{SIMPLE}\n", _tables_ctx("md"))

    assert "| a | b |" in out
    assert SIMPLE not in out


def test_removed_display_formulas_keep_their_page_link() -> None:
    md = (
        "Text with $x$ inline.\n\n"
        "$$\nE = mc^2\n$$\n\n"
        "\\[\n\\int f\n\\]\n[p3](zotero://open-pdf/library/items/K?page=3)\n\n"
        "After."
    )
    ctx = PostCtx(
        content_list=[{"type": "equation", "text": "\\int f"}],
        strip_formulas=True,
    )

    out = pass_formulas(md, ctx)

    assert "Text with $x$ inline." in out
    assert "mc^2" not in out
    assert "\\int f" not in out
    assert "[p3](zotero://open-pdf/library/items/K?page=3)" in out
    assert out.endswith("After.")


def test_formulas_are_kept_by_default() -> None:
    md = "$$\nE = mc^2\n$$"
    assert pass_formulas(md, PostCtx()) == md


def _context(tmp_path: Path) -> ConversionContext:
    out_md = tmp_path / "out.md"
    out_md.write_text(f"# Title\n\n{SIMPLE}\n", encoding="utf-8")
    content_list = tmp_path / "out_content_list.json"
    content_list.write_text(json.dumps([{"type": "table", "page_idx": 0}]), encoding="utf-8")
    return ConversionContext(
        pdf_path=tmp_path / "p.pdf",
        work_dir=tmp_path,
        papers_dir=tmp_path,
        output_root=None,
        citekey="key",
        artifact_key="key",
        meta=PaperMeta(title="T"),
        opts=ConvertOptions(),
        log=lambda _line: None,
        store_dir=tmp_path,
        out_md=out_md,
        content_list_path=content_list,
    )


def _settings(**overrides) -> dict:
    item = TemplateModule(id="content", module="transform.content", settings=overrides)
    return MODULE_REGISTRY.settings_for(item)


@pytest.mark.parametrize("markdown, refined", [("pointer", False), ("html", True)])
def test_vlm_refinement_runs_only_when_tables_reach_the_markdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, markdown: str, refined: bool,
) -> None:
    calls = []

    def fake_refine(_pdf, content_list, body, *_args, **_kwargs):
        calls.append(True)
        return body, content_list, 0

    monkeypatch.setattr(steps, "refine_tables", fake_refine)
    monkeypatch.setattr(steps, "export_tables_html", lambda *_a, **_k: None)
    ctx = _context(tmp_path)

    steps._stage_content(
        ctx, _settings(tables={"markdown": markdown, "refine_complex": True}),
    )

    assert bool(calls) is refined


def test_digest_and_references_can_be_switched_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    exported = []
    monkeypatch.setattr(
        steps, "export_tables_html", lambda *_a, **_k: exported.append(True),
    )
    ctx = _context(tmp_path)

    steps._stage_content(
        ctx, _settings(tables={"digest": False}, references={"extract": False}),
    )

    assert exported == []
    assert ctx.references is None
    assert "Table skipped" in ctx.body
