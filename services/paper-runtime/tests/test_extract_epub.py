"""The MinerU extract stage converts an EPUB without counting or splitting pages."""

from __future__ import annotations

from pathlib import Path

import pytest

from unizero_runtime.pipeline import steps
from unizero_runtime.pipeline.steps import (
    ConversionContext,
    ConvertOptions,
    PaperMeta,
    _stage_extract,
)


def test_epub_is_extracted_whole_without_page_counting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    book = tmp_path / "book.epub"
    book.write_bytes(b"PK")

    def no_pages(_path: Path) -> int:
        raise AssertionError("an EPUB has no pages to count")

    sources: list[str] = []

    def fake_run(cmd: list[str], _log) -> int:
        sources.append(cmd[3])
        out = Path(cmd[4]) / "book"
        out.mkdir(parents=True)
        (out / "book.md").write_text("# Chapter 1\n", encoding="utf-8")
        return 0

    monkeypatch.setattr(steps, "count_pdf_pages", no_pages)
    monkeypatch.setattr(steps, "_run", fake_run)
    ctx = ConversionContext(
        pdf_path=book,
        work_dir=tmp_path / "work",
        papers_dir=tmp_path / "papers",
        output_root=None,
        citekey="book",
        artifact_key="book",
        meta=PaperMeta(),
        opts=ConvertOptions(),
        log=lambda _line: None,
    )

    # Chunking enabled with a tiny threshold would split any PDF.
    _stage_extract(ctx, {"chunking": {"enabled": True, "threshold_pages": 1}})

    assert sources == [str(book)]
    assert ctx.out_md is not None and ctx.out_md.name == "book.md"


@pytest.mark.parametrize(("name", "expected"), [("paper.pdf", "all"), ("book.epub", "")])
def test_page_range_is_sent_only_for_a_pdf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, expected: str,
) -> None:
    # MinerU rejects any page range for an EPUB, even "all".
    import mineru.parser
    from unizero_runtime.providers import mineru as adapter

    class Parsed(Exception):
        pass

    ranges: list[str] = []

    def fake_parse(_source, *, page_range: str, **_kwargs):
        ranges.append(page_range)
        raise Parsed

    monkeypatch.setattr(mineru.parser, "parse", fake_parse)
    with pytest.raises(Parsed):
        adapter.extract(tmp_path / name, tmp_path / "out", "basic", "auto")
    assert ranges == [expected]
