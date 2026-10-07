"""Exercise MinerU's real public result/render APIs without downloading models."""

import json
import sys
from pathlib import Path

import pytest

from unizero_runtime.providers import mineru
from unizero_runtime.providers.references import extract_references
from unizero_runtime.pipeline.steps import inject_zotero_page_links, merge_chunk_outputs


@pytest.fixture
def sdk_result(tmp_path, monkeypatch):
    monkeypatch.setenv("MINERU_HOME", str(tmp_path / "mineru-home"))
    from mineru.parser import ParseResult

    document = {
        "schema": "docvortex.middle", "schema_version": "2.0",
        "metadata": {"file_suffix": "pdf", "producer": {"name": "mineru", "version": "4.0.10"}},
        "extensions": {"mineru": {"tier": "basic", "parse_mode": "txt"}},
        "pages": [{"page_idx": 0, "blocks": [
            {"type": "text", "index": 0,
             "content": [{"type": "text", "content": "A sufficiently long paragraph for page links."}]},
            {"type": "table", "index": 1, "content": [{"type": "table_body", "index": 1,
                "content": "<table><tr><td>A</td></tr></table>"}]},
            {"type": "equation", "index": 2, "content": "x=1"},
            {"type": "image", "index": 3, "content": [{"type": "image_body", "index": 3,
                "content": "", "image_base64":
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII="}]},
            {"type": "paragraph_title", "index": 4, "level": 2,
             "content": [{"type": "text", "content": "References"}]},
            {"type": "ref_text", "index": 5,
             "content": [{"type": "text", "content": "Smith, J. (2024). Example. 10.1000/example"}]},
        ]}], "is_full_document": True,
    }
    for block in document["pages"][0]["blocks"]:
        block["bbox"] = [0, block["index"] * 0.1, 1, block["index"] * 0.1 + 0.05]
        if block["type"] in {"table", "image"}:
            block["content"][0]["bbox"] = block["bbox"]
    return ParseResult.from_dict(document)


@pytest.mark.parametrize("backend,tier", [
    ("basic", "basic"), ("advanced", "advanced"),
    ("flash", "flash"), ("standard", "standard"),
])
def test_worker_command_preserves_paths_and_quality(backend, tier):
    cmd = mineru.command(Path("a folder/paper.pdf"), Path("output folder"), backend)
    assert cmd[:3] == [sys.executable, "-m", "unizero_runtime.providers.mineru"]
    assert cmd[3:5] == [str(Path("a folder/paper.pdf")), "output folder"]
    assert cmd[cmd.index("--tier") + 1] == tier


def test_unknown_backend_and_incompatible_package_fail_before_parsing(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="Unsupported"):
        mineru.command(Path("paper.pdf"), tmp_path, "unknown")
    monkeypatch.setattr(mineru, "version", lambda _: "3.4.4")
    with pytest.raises(RuntimeError, match="requires MinerU 4"):
        mineru.extract(Path("paper.pdf"), tmp_path, "basic", "auto")


@pytest.mark.parametrize("include", [True, False])
def test_sdk_export_keeps_assets_references_and_page_links(tmp_path, monkeypatch, sdk_result, include):
    from mineru import parser as sdk_parser
    calls = []

    def parse(source, **kwargs):
        calls.append(kwargs)
        return sdk_result

    monkeypatch.setattr(sdk_parser, "parse", parse)
    mineru.extract(Path("paper.pdf"), tmp_path, "basic", "ocr", include, include)
    assert calls == [{"tier": "basic", "ocr_mode": "ocr", "page_range": "all"}]
    directory = tmp_path / "paper"
    content_path = directory / "paper_content_list.json"
    content = json.loads(content_path.read_text(encoding="utf-8"))
    assert (any(e["type"] == "table" for e in content)) is include
    assert (any(e["type"] == "equation" for e in content)) is include
    image = next(e for e in content if e["type"] == "image")
    assert (directory / image["img_path"]).is_file()
    assert image["img_path"] in (directory / "markdown.md").read_text(encoding="utf-8")
    references = extract_references(content)
    assert references[0]["page"] == 1
    assert references[0]["identifiers"]["doi"] == "10.1000/example"
    assert inject_zotero_page_links(directory / "markdown.md", content_path,
                                  "zotero://open-pdf/library/items/ABC") == (1, 1)


def test_chunk_merge_accepts_sdk_markdown_filename(tmp_path, monkeypatch, sdk_result):
    from mineru import parser as sdk_parser
    monkeypatch.setattr(sdk_parser, "parse", lambda *args, **kwargs: sdk_result)
    source = Path("chunk_p051-100.pdf")
    root = tmp_path / "chunks"
    mineru.extract(source, root, "basic", "auto")
    output = tmp_path / "merged" / "paper.md"
    count, warnings = merge_chunk_outputs([(source, 51, 100)], root, output, output.parent / "images")
    assert count == 1 and warnings == []
    content = json.loads(output.with_name("paper_content_list.json").read_text(encoding="utf-8"))
    assert all(e["page_idx"] == 50 for e in content)
    image = next(e for e in content if e["type"] == "image")
    assert (output.parent / image["img_path"]).is_file()
    assert Path(image["img_path"]).name.startswith(source.stem + "_")
    assert "images/chunk_p051-100/" in output.read_text(encoding="utf-8")
