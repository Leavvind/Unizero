"""Annotation injection.

Idempotency is the property that matters. The generated Markdown is a living document
the user keeps editing, and the add-on offers "inject annotations" as a repeatable
command -- so running it twice must add nothing the second time, and must never
duplicate or reorder what is already there.
"""

from __future__ import annotations

from pathlib import Path

from unizero_runtime.application.annotations import Annotation, annotate_md


BODY = """---
title: A Paper
citekey: smith2020
---

# Introduction

The quick brown fox jumps over the lazy dog. Machine learning models are
trained on large corpora of text.

# Method

We propose a novel approach to the problem.
"""


def _annotation(key: str, text: str, comment: str = "") -> Annotation:
    return Annotation(
        key=key,
        attachment_key="ATTACH01",
        text=text,
        comment=comment,
        page_label="3",
        sort_index="00000|0000000|00000",
    )


def _write(tmp_path: Path) -> Path:
    md = tmp_path / "smith2020.md"
    md.write_text(BODY, encoding="utf-8")
    return md


def test_injects_a_matching_highlight(tmp_path: Path) -> None:
    md = _write(tmp_path)
    store = tmp_path / "store"

    report = annotate_md(
        md,
        [_annotation("ANN00001", "quick brown fox")],
        store,
        "smith2020",
    )

    assert report["injected"] == 1
    text = md.read_text(encoding="utf-8")
    assert "ANN00001" in text
    assert "quick brown fox" in text


def test_second_run_injects_nothing(tmp_path: Path) -> None:
    md = _write(tmp_path)
    store = tmp_path / "store"
    annotations = [
        _annotation("ANN00001", "quick brown fox"),
        _annotation("ANN00002", "novel approach"),
    ]

    first = annotate_md(md, annotations, store, "smith2020")
    after_first = md.read_text(encoding="utf-8")

    second = annotate_md(md, annotations, store, "smith2020")
    after_second = md.read_text(encoding="utf-8")

    assert first["injected"] == 2
    assert second["injected"] == 0
    assert second["already"] == 2
    # Byte-identical, not merely "no new keys": a re-run must not reflow the document.
    assert after_first == after_second


def test_unmatched_annotations_are_reported_not_dropped_silently(tmp_path: Path) -> None:
    md = _write(tmp_path)
    store = tmp_path / "store"

    report = annotate_md(
        md,
        [_annotation("ANN00009", "this sentence is absent from the document")],
        store,
        "smith2020",
    )

    assert report["injected"] == 0
    assert len(report["skipped"]) == 1


def test_state_survives_a_lost_store_because_markers_are_in_the_document(
    tmp_path: Path,
) -> None:
    """The store is a cache, not the source of truth.

    If the user syncs Markdown to a new machine without the runtime home, re-running
    injection must still not duplicate: the keys are recoverable from the document.
    """
    md = _write(tmp_path)
    store = tmp_path / "store"
    annotations = [_annotation("ANN00001", "quick brown fox")]

    annotate_md(md, annotations, store, "smith2020")
    before = md.read_text(encoding="utf-8")

    fresh_store = tmp_path / "store-elsewhere"
    report = annotate_md(md, annotations, fresh_store, "smith2020")

    assert report["injected"] == 0
    assert md.read_text(encoding="utf-8") == before


def test_incremental_injection_adds_only_the_new_one(tmp_path: Path) -> None:
    md = _write(tmp_path)
    store = tmp_path / "store"

    annotate_md(md, [_annotation("ANN00001", "quick brown fox")], store, "smith2020")
    report = annotate_md(
        md,
        [
            _annotation("ANN00001", "quick brown fox"),
            _annotation("ANN00002", "novel approach"),
        ],
        store,
        "smith2020",
    )

    assert report["injected"] == 1
    assert report["already"] == 1
    text = md.read_text(encoding="utf-8")
    assert text.count("ANN00001") == 1
    assert text.count("ANN00002") == 1
