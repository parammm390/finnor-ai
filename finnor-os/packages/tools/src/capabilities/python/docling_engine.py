"""OCR/layout/table extraction of exact authorized bytes; no URL input."""
import base64
import contextlib
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import sys


def run(payload):
    # Models are provisioned explicitly during image construction. A document
    # request may not trigger an unbounded network/model download.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    models = payload.get("modelsPath")
    if not isinstance(models, str) or not Path(models).is_dir():
        raise ValueError("DOCLING_MODELS_NOT_PROVISIONED")
    manifest_path = Path(models) / "finnor-model-manifest.json"
    if not manifest_path.is_file():
        raise ValueError("DOCLING_MODEL_MANIFEST_REQUIRED")
    manifest = manifest_path.read_bytes()
    declared = json.loads(manifest)
    if declared.get("schema") != "finnor.docling-models.v1" or declared.get("docling") != importlib.metadata.version("docling"):
        raise ValueError("DOCLING_MODEL_MANIFEST_MISMATCH")
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableStructureOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling_core.types.io import DocumentStream

    data = base64.b64decode(payload.get("bytesBase64", ""), validate=True)
    if not data.startswith(b"%PDF-"):
        raise ValueError("DOCLING_PDF_SOURCE_REQUIRED")
    if len(data) > 10485760:
        raise ValueError("DOCLING_SOURCE_TOO_LARGE")
    if hashlib.sha256(data).hexdigest() != payload.get("sha256"):
        raise ValueError("DOCLING_SOURCE_DIGEST_MISMATCH")
    options = PdfPipelineOptions(artifacts_path=Path(models))
    options.do_ocr = True
    options.do_table_structure = True
    options.table_structure_options = TableStructureOptions(do_cell_matching=True)
    options.ocr_options.force_full_page_ocr = payload.get("forceOcr") is True
    options.accelerator_options = AcceleratorOptions(num_threads=1, device=AcceleratorDevice.CPU)
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF], format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    converted = converter.convert(DocumentStream(name="source.pdf", stream=io.BytesIO(data)), max_num_pages=500, max_file_size=10485760)
    status = str(converted.status.value)
    document = converted.document
    exported = document.export_to_dict()
    markdown = document.export_to_markdown()
    warnings = [{"code": "EXTRACTION_NOT_FULL_SUCCESS"}] if status != "success" else []
    if len(markdown) > 1048576:
        markdown = markdown[:1048576]
        warnings.append({"code": "MARKDOWN_TRUNCATED"})
    # Native Docling provenance is retained intact, and every usable location is
    # also bound to the caller's immutable FINNOR document version.
    anchors = []
    for group in (exported.get("texts", []), exported.get("tables", []), exported.get("pictures", [])):
        for item in group:
            for location in item.get("prov", []):
                anchors.append({"nodeRef": item.get("self_ref"), "label": item.get("label"),
                    "page": location.get("page_no"), "bbox": location.get("bbox"), "charspan": location.get("charspan"), "source": payload["source"]})
    if not anchors:
        warnings.append({"code": "NO_SOURCE_LOCATIONS_EXTRACTED"})
    return {"schema": "finnor.docling-extraction.v1", "source": payload["source"], "status": status,
        "document": exported, "markdown": markdown, "anchors": anchors, "warnings": warnings,
        "backend": {"name": "docling", "version": importlib.metadata.version("docling"), "python": sys.version.split()[0], "modelManifestSha256": hashlib.sha256(manifest).hexdigest()},
        "qualification": "UNTRUSTED_EXTRACTED_EVIDENCE", "canonicalTruthEstablished": False, "executionAuthorityGranted": False}


if __name__ == "__main__":
    source_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    try:
        request = json.loads(sys.stdin.buffer.read(16777217))
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({"ok": True, "sourceSha256": source_digest, "result": result}, allow_nan=False, separators=(",", ":")))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "DOCLING_DEPENDENCY_UNAVAILABLE"}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith("DOCLING_") else "DOCLING_EXTRACTION_FAILED"
        print(json.dumps({"ok": False, "code": code}))
