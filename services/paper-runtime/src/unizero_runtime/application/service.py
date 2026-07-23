"""ZoMiner application services, independent from FastAPI transport details."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.request
from pathlib import Path
from typing import Optional

from .. import paths
from ..contracts import AnnotateRequest
from ..pipeline.steps import (
    ConvertOptions,
    PaperMeta,
    convert_pdf,
    resolve_obsidian_destination,
)
from ..pipeline.templates import TemplateStore
from ..providers.semantic_scholar import s2_lookup
from .annotations import (
    Annotation,
    annotate_md,
    citekey_of_md,
    find_md_by_attachment,
    find_md_by_citekey,
)
from .config import ConfigStore
from .jobs import Job


_SAFE_CHARS = re.compile(r"[^A-Za-z0-9_\-]+")


class ServiceError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _mineru_executable() -> str:
    sibling = Path(sys.executable).with_name(
        "mineru.exe" if sys.platform == "win32" else "mineru",
    )
    if sibling.is_file():
        return str(sibling)
    return shutil.which("mineru") or "mineru"


def detect_mineru_version() -> str:
    try:
        output = subprocess.run(
            [_mineru_executable(), "--version"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout
        match = re.search(r"version\s+([\d.]+)", output)
        return match.group(1) if match else ""
    except Exception:
        return ""


def slug_fallback(title: str, year: str, first_author: str) -> str:
    base = ""
    if first_author:
        normalized = unicodedata.normalize("NFKD", first_author)
        base += _SAFE_CHARS.sub("", normalized.split(",")[0].split(" ")[-1])
    if year:
        base += year
    if not base:
        base = _SAFE_CHARS.sub("-", title)[:40].strip("-") or "paper"
    return base


def safe_dirname(name: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return value[:120] or "untitled"


class ZoMinerApplication:
    def __init__(
        self,
        config: ConfigStore,
        templates: TemplateStore,
        store_dir: Path | None = None,
    ):
        self.config = config
        self.templates = templates
        # Annotation injection records live here. Injected rather than derived from
        # __file__ so the package directory stays read-only; see paths.py.
        self.store_dir = store_dir or paths.store_dir(config.home)
        self.mineru_version = detect_mineru_version()

    def _citekey_from_bbt(
        self,
        item_key: str,
        library_id: int = 1,
        cfg: Optional[dict] = None,
    ) -> Optional[str]:
        try:
            effective = cfg or self.config.snapshot()
            payload = json.dumps({
                "jsonrpc": "2.0",
                "method": "item.citationkey",
                "params": [[f"{library_id}:{item_key}"]],
                "id": 1,
            }).encode()
            request = urllib.request.Request(
                effective["bbt_rpc"],
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                data = json.loads(response.read())
            for value in (data.get("result") or {}).values():
                if value:
                    return str(value)
        except Exception:
            pass
        return None

    @staticmethod
    def _output_root(cfg: dict) -> Path | None:
        root = str(cfg.get("vault_root") or "").strip()
        return Path(root) if root else None

    @staticmethod
    def _validate_publish_destination(template, output_root: Path | None) -> None:
        for item in template.modules:
            if not item.enabled or item.module != "publish.markdown-directory":
                continue
            destination = str(item.settings.get("destination") or "").strip()
            if destination.startswith("obsidian://"):
                try:
                    resolve_obsidian_destination(destination)
                except RuntimeError as exc:
                    raise ServiceError("obsidian_vault_not_found", str(exc))
                return
            if destination and Path(destination).is_absolute():
                return
            if output_root is not None:
                return
            raise ServiceError(
                "output_base_not_configured",
                "Publish 目标目录是相对路径，但未配置默认输出基目录；"
                "请在设置中填写基目录，或在模板 Publish 中使用绝对路径",
            )

    def _publish_directories(self, cfg: dict) -> list[Path]:
        """Known output roots without introducing an artifact index."""
        root = self._output_root(cfg)
        directories = [root / cfg["papers_dir"]] if root is not None else []
        for template in self.templates.list():
            for item in template.get("modules", []):
                if item.get("module") != "publish.markdown-directory":
                    continue
                destination = str(
                    (item.get("settings") or {}).get("destination") or "",
                ).strip()
                if not destination:
                    continue
                if destination.startswith("obsidian://"):
                    try:
                        resolved = resolve_obsidian_destination(destination)
                    except RuntimeError:
                        continue
                else:
                    path = Path(destination)
                    if not path.is_absolute() and root is None:
                        continue
                    resolved = path if path.is_absolute() else root / path
                if resolved not in directories:
                    directories.append(resolved)
        if not directories:
            raise ServiceError(
                "publish_destination_not_configured",
                "没有可解析的 Publish 目录；请设置默认输出基目录，"
                "或在模板 Publish 中使用绝对路径",
            )
        return directories

    def process_conversion(self, job: Job) -> None:
        request = job.request
        pdf = Path(request.pdf_path)
        if not pdf.exists():
            raise ServiceError("pdf_not_found", f"PDF not found: {pdf}")

        cfg = self.config.snapshot()
        citekey = request.citekey or ""
        if not citekey and request.item_key:
            citekey = self._citekey_from_bbt(
                request.item_key,
                request.library_id,
                cfg,
            ) or ""
            if citekey:
                job.append(f"[citekey] via Better BibTeX: {citekey}")
        if not citekey:
            first_author = request.authors[0] if request.authors else ""
            citekey = slug_fallback(request.title, request.year, first_author)
            job.append(f"[citekey] fallback slug: {citekey}")

        doc_key = citekey
        title = request.title or pdf.stem
        if request.is_supplement:
            attachment_title = request.attachment_title or "Supplement"
            suffix = (
                re.sub(r"[^A-Za-z0-9]+", "", attachment_title).lower()[:24]
                or request.attachment_key
                or "supp"
            )
            doc_key = f"{citekey}-{suffix}"
            title = f"{title} — {attachment_title}"
            job.append(f"[supplement] doc key: {doc_key}")

        meta = PaperMeta(
            title=title,
            authors=request.authors,
            year=request.year,
            citekey=doc_key,
            doi="" if request.is_supplement else request.doi,
            publication=request.publication,
            item_key=request.item_key,
            attachment_key=request.attachment_key,
        )

        enrich = None
        if not request.is_supplement:
            def enrich(meta_to_enrich: PaperMeta, log) -> None:
                result = s2_lookup(doi=meta_to_enrich.doi, title=request.title)
                if result is None:
                    log("[s2] no match found")
                    return
                meta_to_enrich.s2_url = result["s2_url"]
                meta_to_enrich.s2_citations = result.get("citations")
                meta_to_enrich.doi = meta_to_enrich.doi or result.get("doi", "")
                log(
                    f"[s2] {meta_to_enrich.s2_url} "
                    f"(citations: {meta_to_enrich.s2_citations})",
                )

        options_config = dict(cfg["options"])
        if request.options:
            options_config.update(request.options.model_dump(exclude_none=True))
        options = ConvertOptions(**options_config)
        template = self.templates.get(request.template_id)
        if template is None:
            raise ServiceError(
                "template_not_found",
                f"unknown template '{request.template_id}'",
            )
        output_root = self._output_root(cfg)
        self._validate_publish_destination(template, output_root)
        papers_dir = (
            output_root / cfg["papers_dir"]
            if output_root is not None
            else Path(cfg["papers_dir"])
        )
        safe_key = safe_dirname(doc_key)
        work_dir = Path(cfg["work_dir"]) / f"{safe_key}_{job.id[:8]}"

        job.append(f"[job] {pdf.name} ({safe_key})")
        result = convert_pdf(
            pdf_path=pdf,
            work_dir=work_dir,
            papers_dir=papers_dir,
            citekey=safe_key,
            meta=meta,
            opts=options,
            log=job.append,
            mineru_version=self.mineru_version,
            store_dir=self.store_dir,
            fm_cfg=cfg.get("frontmatter"),
            template=template,
            output_root=output_root,
            enrich=enrich,
        )
        for warning in result.warnings:
            job.append(f"[warn] {warning}")
        job.result = {
            "md_path": str(result.md_path),
            "images_dir": str(result.images_dir) if result.images_dir else None,
            "tables_html_path": (
                str(result.tables_html_path) if result.tables_html_path else None
            ),
            "pages_found": result.pages_found,
            "pages_injected": result.pages_injected,
            "citekey": doc_key,
            "warnings": result.warnings,
            "template": result.workflow,
            "workflow": result.workflow,
            "references": result.references,
            "references_count": len(result.references),
        }
        shutil.rmtree(work_dir, ignore_errors=True)

    def annotate(self, request: AnnotateRequest) -> dict:
        cfg = self.config.snapshot()
        citekey = request.citekey
        if not citekey and request.item_key:
            citekey = self._citekey_from_bbt(
                request.item_key,
                request.library_id,
                cfg,
            ) or ""
        if not citekey:
            raise ServiceError(
                "citekey_unresolved",
                "citekey unresolved (is Better BibTeX running?)",
            )

        publish_dirs = self._publish_directories(cfg)
        main_md = next(
            (
                target
                for directory in publish_dirs
                if (target := find_md_by_citekey(directory, citekey)) is not None
            ),
            None,
        )
        annotations = [
            Annotation(
                key=item.key,
                attachment_key=item.attachment_key,
                text=item.text,
                comment=item.comment,
                page_label=item.page_label,
                sort_index=item.sort_index,
            )
            for item in request.annotations
            if item.key and item.text
        ]
        annotations.sort(key=lambda item: item.sort_index)

        groups: dict[str, list[Annotation]] = {}
        for item in annotations:
            groups.setdefault(item.attachment_key, []).append(item)

        total = {
            "md_path": "",
            "total": len(annotations),
            "injected": 0,
            "already": 0,
            "skipped": [],
            "unrouted": 0,
        }
        routed_any = False
        for attachment_key, group in groups.items():
            target = next(
                (
                    found
                    for directory in publish_dirs
                    if (
                        found := find_md_by_attachment(directory, attachment_key)
                    ) is not None
                ),
                None,
            ) or main_md
            if target is None:
                total["unrouted"] += len(group)
                continue
            routed_any = True
            doc_key = citekey_of_md(target) or citekey
            report = annotate_md(target, group, self.store_dir, doc_key)
            total["md_path"] = total["md_path"] or report["md_path"]
            total["injected"] += report["injected"]
            total["already"] += report["already"]
            total["skipped"] += report["skipped"]
        if not routed_any:
            raise ServiceError(
                "markdown_not_found",
                f"no MD for citekey {citekey} — 先生成论文 MD",
                status_code=404,
            )
        return total

    def health(self, queued: int) -> dict:
        cfg = self.config.snapshot()
        return {
            "ok": True,
            "mineru_version": self.mineru_version,
            "vault": cfg["vault_root"],
            "vault_configured": bool(str(cfg.get("vault_root") or "").strip()),
            "papers_dir": cfg["papers_dir"],
            "queued": queued,
            "workflows": self.templates.list(),
        }
